---
title: "实战踩坑录 06 · 两套 skill 体系生命周期不对齐：prompt skill vs 本地 skill package 统一注册与卸载"
date: "2026-08-08"
description: "prompt skill 有 propose→approve→install / uninstall_propose 完整会话内生命周期；本地 skill package 只有 enable/disable + 全量 reload。卸载一个 package 还得手动 rm 目录，watcher 一启动又复活。统一入口 + .trash 语义对齐两个体系。"
tags: [AI Agent, Skill, 生命周期, 注册, 卸载, Watcher]
draft: true
---

## 一、症状

AI 工作台里同时存在两套 skill：

| 类型 | 位置 | 例子 | 安装 | 卸载 |
|---|---|---|---|---|
| **prompt skill** | `.agents/skills/*.md`（纯文本） | `frontend-slides` | propose→approve→install | propose_uninstall→approve→uninstall |
| **本地 skill package** | `skills/<id>/`（含 handler.py） | `document_generation` | 整目录扫描 + enable/disable | **没有**——只能整目录 rm |

问题：

1. 用户想卸载一个本地包：手动 `rm -rf skills/foo`，但 `SkillPackageLoader.discover()` 每 30s 跑一次（watcher），目录又会出现。
2. prompt skill 安装时 SKILL.md 被改写注入了 `workbench_entrypoint: WORKBENCH.md`，导致 `skill_read` 默认返回受限流程而非原版设计。
3. 两套体系的口径不一致：管理面只能操作 prompt skill，本地包只能 CLI 操作。

---

## 二、根因

### 根因 1：watcher 复活

```python
# src/customer_service_ai/skill_packages.py:153-158
class SkillPackageLoader:
    def discover(self):
        packages = []
        for entry in self.trusted_root.iterdir():
            if entry.name.startswith("."):    # 只跳过 . 开头的目录
                continue
            if entry.is_dir():
                packages.append(self._load(entry))
        return packages
```

`watcher.py` 每 30s 调一次 `discover()` + `reload_skill_packages()`，所以即使 `rm` 了，下次跑就又加载回来。

### 根因 2：卸载语义不统一

- prompt skill 的 `.trash` 目录（`.` 前缀）天然被 `discover()` 跳过 → 卸载 = 移入 `.trash`，可恢复。
- 本地 skill package 没有 `.trash` 对应物，也没有任何「软删」路径。

### 根因 3：SKILL.md 注入劫持

`SkillInstallationService._install()` 在落盘 SKILL.md 时，无脑注入 `workbench_entrypoint: WORKBENCH.md`，把原版自由 HTML 设计流强制改写成「走模板确定性渲染」流。卸载再装回来仍然会被注入，除非直接读 GitHub raw 重装。

---

## 三、修复

三步走：对齐两个 lifecycle、补 install_direct、清理 frontend-slides。

### 步骤 1 · 本地 skill package 的 register / unregister

```python
# src/customer_service_ai/operations_service.py
class OperationsService:
    def register_skill_package(self, package_id: str) -> dict:
        trash = self._skill_root / ".trash" / package_id
        live  = self._skill_root / package_id
        if trash.exists():
            shutil.move(trash, live)              # 恢复
        elif not live.exists():
            raise SkillPackageError(f"package {package_id} 不存在")
        # 幂等重注册
        self.reload_skill_packages()
        return {"ok": True, "package_id": package_id}

    def unregister_skill_package(self, package_id: str) -> dict:
        status = self.skill_package_status()
        entry = next((e for e in status if e["id"] == package_id), None)
        if entry is None:
            raise SkillPackageError(f"未找到 package {package_id}")
        live = Path(entry["path"])
        if not str(live.resolve()).startswith(str(self._skill_loader.trusted_root.resolve())):
            raise SkillPackageError("path traversal detected")     # 防误删
        trash = self._skill_root / ".trash" / package_id
        trash.mkdir(parents=True, exist_ok=True)
        # 处理重名：加时间戳
        if any(trash.iterdir()):
            ts = int(time.time())
            shutil.move(live, trash.with_name(f"{package_id}-{ts}"))
        else:
            shutil.move(live, trash)
        self.reload_skill_packages()               # 触发 fork_without_source("package:")
        self.record_skill_package_event(package_id, "unregistered", ...)
        return {"ok": True, "package_id": package_id}
```

`.trash` 是 `.` 开头，`discover()` 天然跳过；watcher 不会复活。

### 步骤 2 · prompt skill 的 install_direct（CLI 直装）

现有 `propose → approve` 需要 conversation 上下文（actor_id、tenant_id、conversation_id），CLI 没有。所以加一条免提案直装路径：

```python
# src/customer_service_ai/skill_installation.py
class SkillInstallationService:
    def install_direct(self, source_url: str, *, tenant_id: str,
                       actor_id: str, actor_label: str) -> dict:
        # 复用 _github_source_candidate / _resolve_github_commit / _download
        # / _extract / _verification 全部既有逻辑
        # 跳过 propose/DB proposal 表，直接写 skill_installations + origin.json + lock
        # 然后 prompt_registry.reload()
        candidate = self._github_source_candidate(source_url)
        commit   = self._resolve_github_commit(candidate)
        payload  = self._download(candidate, commit)
        extracted = self._extract(payload)
        self._verification(extracted, candidate)
        row = self._finalize_install(extracted, candidate, tenant_id=tenant_id,
                                     actor_id=actor_id, actor_label=actor_label)
        self.prompt_registry.reload()
        return {"ok": True, "slug": row.slug, "version": row.version}
```

`_finalize_install` 是从 `approve()` 里抽出来的私有方法，两条路径共用，保证「CLI 装」和「会话装」行为一致。

### 步骤 3 · frontend-slides 恢复原版

```bash
# 1. 用新的 uninstall 卸掉被改写的实例（进 .trash，可回滚）
python scripts/skill_ctl.py uninstall --kind prompt frontend-slides

# 2. 用 install_direct 从 GitHub 重装，得到原版 SKILL.md
python scripts/skill_ctl.py register --kind prompt \
    https://github.com/zarazhangrui/frontend-slides/tree/main

# 3. 验证 skill_read 返回原版正文（无 WORKBENCH.md 劫持）
python scripts/skill_ctl.py show frontend-slides
```

---

## 四、统一只读视图

管理面和 CLI 都用同一个 list：

```python
def unified_skill_status() -> list[dict]:
    items = []
    # 本地 package
    for entry in skill_package_status():
        items.append({
            "kind": "package",
            "id": entry["id"],
            "name": entry["name"],
            "description": entry["description"],
            "status": entry["status"],      # enabled / disabled / error / uninstalled
            "source": "local",
            "version": entry["version"],
            "path": entry["path"],
            "capabilities": entry["capabilities"],
        })
    # prompt skill
    for slug, meta in prompt_registry.list().items():
        install = skill_installations.list_installations(slug, scope="global")[0]
        items.append({
            "kind": "prompt",
            "id": slug,
            "name": meta["name"],
            "description": meta["description"],
            "status": install.status,       # enabled / disabled / uninstalled
            "source": meta.get("source", "clawhub"),
            "version": install.version,
            "path": install.path,
            "capabilities": [],             # prompt skill 不注册 capability
        })
    return items
```

HTTP 端点：

```
GET    /api/admin/skills               # 统一视图
POST   /api/admin/skills/{pkg}/register
DELETE /api/admin/skills/{pkg}         # 本地 package unregister
POST   /api/admin/prompt-skills        # prompt skill install_direct
DELETE /api/admin/prompt-skills/{slug}
POST   /api/admin/prompt-skills/{slug}/enable|disable
```

全部由 admin key 保护；会话内 capability 仍然只能 propose，不直接动这套管理面。

---

## 五、可复用清单 · Skill 生命周期

1. **卸载一律走「移入 `.trash`」**，不要 `rm -rf`。`.` 前缀天然被 `discover()` 跳过，可恢复、可审计。
2. **reload 必须配套**：`register` / `unregister` 后调 `reload_skill_packages()`，否则 watcher 会把状态再覆盖回来。
3. **签名校验不要绕**：`register` 恢复路径仍然走 `_verify_signature`，跟正常安装路径同样严格。
4. **in-use 卸载是安全的**：能力注销只影响后续调用；进行中的会话在下一轮刷新工具目录。
5. **CLI / admin 直装 vs 会话 propose 是两套路径**：CLI 是运维入口（admin key / 本机），会话内仍然只能 propose / approve，不直接绕过审批。

---

## 六、相关坑

- [[2026-08-08-pitfalls-07-zip-install-skill-monorepo]] · 客户端 zip 上传装 skill 时，沿用 prompt skill 的 `propose → approve` 框架，多 skill monorepo 在这里派生。
- [[2026-08-08-pitfalls-08-builtin-skills-vs-docker-volume]] · 内置 skill 是「想装但不需要安装」的反向极端：跟普通 skill 不一样，根本不该走 install/uninstall。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · skill 的能力注册最终落到 `_BUILTIN_IDS` 集合；新增 capability 必须同步更新两处。