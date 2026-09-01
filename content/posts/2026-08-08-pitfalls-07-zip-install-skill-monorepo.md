---
title: "实战踩坑录 07 · 客户端 zip 上传装 skill：单包 vs 多 skill monorepo 的全链路处理"
date: "2026-08-08"
description: "上传一个 zip 装 skill。最常见的 zip 根就是一个 SKILL.md，但也可能是 monorepo（6 个子目录各有 SKILL.md）。要扩展解压逻辑、加临时载荷表、复用 propose→approve 治理框架。"
tags: [AI Agent, Skill, Zip, Monorepo, 安装, 安全]
draft: true
---

## 一、症状

Assistant 对话里拖一个 zip 进去，期望 agent 提议安装。实际：

1. **单包 zip**（zip 根直接有 SKILL.md）：装得上。
2. **多 skill monorepo**（zip 根有 6 个子目录，每个含 SKILL.md）：当前 `_extract()` 只解析第一个 SKILL.md，其余 5 个被忽略。
3. **路径穿越 zip**（含 `../etc/passwd` 软链接）：当前实现没拦截，被打到 install_root 时跳出沙箱。
4. **重复 slug**：先装了 v1，再上传含同 slug 的 zip，没拦截，覆盖式覆盖。

测试样本 `/Users/wuguobin/Downloads/khazix-skills-main.zip`（210KB）就是 monorepo，6 个 skill：`aihot` / `hv-analysis` / `khazix-writer` / `leader` / `neat-freak` / `storage-analyzer`。

---

## 二、根因

`_extract()` 的旧假设是「zip 根里只有一个 SKILL.md，或者顶层就是 skill 目录」：

```python
# src/customer_service_ai/skill_installation.py:1575 (原版)
def _extract(self, payload: bytes) -> Path:
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        members = zf.namelist()
        if any(m.startswith("..") or "\\" in m or m.startswith("/") for m in members):
            raise SkillInstallationError("unsafe path in zip")
        # 只看根级 SKILL.md
        root_md = next((m for m in members if m.endswith("SKILL.md")), None)
        if root_md is None:
            raise SkillInstallationError("zip 缺少 SKILL.md")
        # 整个解压到一个临时目录
        ...
```

这个实现没处理 monorepo（多个 SKILL.md 都在二级目录），也没限制「zip 内嵌 symlink」「单文件超 2MB」「总文件数 > 300」之类的硬上限。

---

## 三、修复

按依赖顺序：先扩展解压 → 加临时载荷表 → HTTP 端点 → capability 注册 → 前端 UI。

### 步骤 1 · 扩展 `_extract_monorepo()`

```python
def _inspect_uploaded_zip(self, payload: bytes) -> list[dict]:
    """返回每个候选 skill 的 {slug, display_name, summary, manifest, files}。"""
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        # 1. 总文件数 / 单文件 / 总字节硬上限
        if len(zf.namelist()) > self._MAX_FILES * 6:                # monorepo 上限
            raise SkillInstallationError("文件数超限（monorepo 上限 600）")
        total_uncompressed = sum(i.file_size for i in zf.infolist())
        if total_uncompressed > self._MAX_EXPANDED_BYTES * 4:      # monorepo 上限 100MB
            raise SkillInstallationError("解压后总字节超限")
        for info in zf.infolist():
            if info.file_size > self._MAX_FILE_BYTES:
                raise SkillInstallationError(f"{info.filename} 超过单文件 2MB 上限")
            # 2. 拒绝 symlink / 路径穿越
            if info.filename.startswith("..") or "\\" in info.filename:
                raise SkillInstallationError(f"unsafe path: {info.filename}")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise SkillInstallationError(f"symlink not allowed: {info.filename}")

        # 3. 识别 monorepo：根下有 ≥ 2 个直接子目录，每个含 SKILL.md
        candidates: list[dict] = []
        root_dirs: set[str] = set()
        for n in zf.namelist():
            parts = n.split("/")
            if len(parts) >= 2 and parts[0] and not parts[0].startswith("."):
                root_dirs.add(parts[0])

        for sub in sorted(root_dirs):
            md = f"{sub}/SKILL.md"
            if md not in zf.namelist():
                continue
            text = zf.read(md).decode("utf-8")
            try:
                fm, body = frontmatter.loads(text)
            except Exception:
                continue
            slug = (fm.get("name") or sub).strip().lower().replace(" ", "-")
            candidates.append({
                "slug": slug,
                "display_name": fm.get("name") or sub,
                "summary": fm.get("description", "").strip(),
                "manifest": dict(fm),
                "files": [n for n in zf.namelist() if n.startswith(f"{sub}/")],
            })
        if not candidates:
            raise SkillInstallationError("bundle 缺少有效 SKILL.md")
        return candidates
```

### 步骤 2 · 临时载荷表

`propose` 时需要保留 zip 字节供 `approve` 后落盘。新增一张临时表：

```sql
CREATE TABLE IF NOT EXISTS skill_install_proposal_payloads (
    proposal_id TEXT PRIMARY KEY,
    payload BLOB NOT NULL,
    created_at TEXT NOT NULL
);
```

```python
def propose_uploaded_zip(
    self, *, payload: bytes, filename: str,
    tenant_id: str, actor_id: str, conversation_id: str,
    selected_slugs: list[str] | None = None,
) -> list[dict]:
    candidates = self._inspect_uploaded_zip(payload)

    # 已安装的过滤
    installed = {row.slug for row in self.list_installations(scope="tenant", tenant_id=tenant_id)}
    candidates = [c for c in candidates if c["slug"] not in installed]

    if selected_slugs is not None:
        candidates = [c for c in candidates if c["slug"] in set(selected_slugs)]

    proposals = []
    for c in candidates:
        sha = hashlib.sha256(payload).hexdigest()[:12]
        skill_ref = f"upload://{sha}/{c['slug']}"
        proposal_id = self._insert_proposal(
            tenant_id=tenant_id,
            actor_id=actor_id,
            conversation_id=conversation_id,
            skill_ref=skill_ref,
            registry_url="upload://local",
            display_name=c["display_name"],
            summary=c["summary"],
            manifest=c["manifest"],
        )
        # 临时载荷落库
        self.db.execute(
            "INSERT OR REPLACE INTO skill_install_proposal_payloads (proposal_id, payload, created_at) "
            "VALUES (?, ?, ?)",
            (proposal_id, payload, _now_iso()),
        )
        self.db.commit()
        proposals.append({
            "proposal_id": proposal_id,
            "slug": c["slug"],
            "display_name": c["display_name"],
            "summary": c["summary"],
            "sha256": sha,
        })
    return proposals
```

`approve()` 走 `_install(row)` → `_materialize_install(row)`，我们在 `_materialize_install` 里加 upload 分支：

```python
def _materialize_install(self, row) -> Path:
    if row.registry_url == "upload://local":
        payload_row = self.db.execute(
            "SELECT payload FROM skill_install_proposal_payloads WHERE proposal_id = ?",
            (row.proposal_id,),
        ).fetchone()
        if payload_row is None:
            raise SkillInstallationError("upload payload expired")
        # 找到当前 slug 对应的子目录
        slug = row.skill_ref.split("/")[-1]
        install_root = self._extract_one_for_slug(payload_row["payload"], slug)
        # 用完即删
        self.db.execute("DELETE FROM skill_install_proposal_payloads WHERE proposal_id = ?",
                        (row.proposal_id,))
        self.db.commit()
        return install_root
    # ... 原有 GitHub 路径
```

**不调 `_verification()`**：本地 zip 已经是用户亲手上传，由人工确认承担安全门。

### 步骤 3 · HTTP 端点

```python
# src/customer_service_ai/workbench/assistant/api.py
@router.post("/skill-installations/from-artifact")
async def from_artifact(req: FromArtifactRequest, ...):
    artifact = artifacts.resolve(req.artifact_id)
    if artifact.mime_type != "application/zip":
        raise HTTPException(422, "artifact 必须是 zip")
    payload = artifacts.read_bytes(req.artifact_id)
    proposals = skill_installation_service.propose_uploaded_zip(
        payload=payload,
        filename=artifact.filename,
        tenant_id=req.tenant_id,
        actor_id=req.actor_id,
        conversation_id=req.conversation_id,
        selected_slugs=req.selected_slugs,
    )
    return {"proposals": proposals}
```

`ArtifactService._ALLOWED_INPUTS`（`artifacts/service.py:35`）追加 `.zip`，这样客户端上传走原有 `/api/conversations/{id}/artifacts/import` 端点即可。

### 步骤 4 · Agent capability

```python
# src/customer_service_ai/workbench/assistant/runtime.py
class SkillInstallFromZipRequest(BaseModel):
    artifact_id: str
    selected_slugs: list[str] | None = None
    conversation_id: str

async def handle_skill_install_from_zip(self, req, ctx):
    proposals = self.skill_installation.propose_uploaded_zip(...)
    return CapabilityResult(output={
        "proposals": proposals,
        "message": f"检测到 {len(proposals)} 个候选 skill，请在对话中确认安装。",
    })

registry.register_skill(
    capability_id="workbench.skill_install_from_zip",
    handler=handle_skill_install_from_zip,
    input_model=SkillInstallFromZipRequest,
    risk_level=CapabilityRisk.DRAFT_WRITE,
)
```

### 步骤 5 · 前端 UI（最小改动）

```ts
// apps/desktop/src/main/ipc-handlers.ts
const dialogOptions = {
  filters: [{ name: "Skill bundle", extensions: ["zip"] }],   // 追加 zip
};

// AssistantPage.tsx: 上传完 zip 后，弹一段「检测到 N 个候选 skill，是否安装？」的 banner
// 触发 workbench.skill_install_from_zip capability，渲染已有 proposal 卡片
```

---

## 四、验证矩阵

```python
# tests/test_skill_install_zip.py

def test_propose_single_skill_zip(zip_with_one_skill):
    proposals = svc.propose_uploaded_zip(payload=..., filename="x.zip",
                                         tenant_id="t", actor_id="a", conversation_id="c")
    assert len(proposals) == 1

def test_propose_monorepo_zip(khazix_skills_main_zip):
    proposals = svc.propose_uploaded_zip(payload=..., filename="khazix.zip", ...)
    assert len(proposals) == 6
    slugs = {p["slug"] for p in proposals}
    assert slugs == {"aihot","hv-analysis","khazix-writer","leader","neat-freak","storage-analyzer"}

def test_rejects_zip_with_no_skill_md():
    with pytest.raises(SkillInstallationError) as ei:
        svc.propose_uploaded_zip(payload=zip_without_skill_md, ...)
    assert "缺少有效 SKILL.md" in str(ei.value)

def test_rejects_symlink():
    with pytest.raises(SkillInstallationError) as ei:
        svc.propose_uploaded_zip(payload=zip_with_symlink, ...)
    assert "symlink" in str(ei.value)

def test_rejects_duplicate_slug():
    svc.propose_uploaded_zip(...)      # 装第一个
    with pytest.raises(SkillInstallationError) as ei:
        svc.propose_uploaded_zip(payload=same_slug_zip, ...)
    assert "已安装" in str(ei.value)
```

端到端（桌面客户端）：

```text
1. 打开 Assistant 对话
2. 点纸夹 → 选 khazix-skills-main.zip
3. agent 自动提议：检测到 6 个候选 skill，是否全部安装？
4. 选「全部安装」 → 6 张 proposal 卡片出现
5. 用户逐个点确认 → skill_installations 表新增 6 行 enabled
6. PromptSkillRegistry.reload() 后新对话 system prompt 里 <available_skills> 含 6 个 name
```

---

## 五、可复用清单 · 上传即安装

1. **总文件数 / 单文件 / 总字节三个上限分开算**：单包 300/2MB/30MB；monorepo 按 skill 数平摊到 600/2MB/100MB。
2. **路径 / symlink / `..` / `\\` 全部拒绝**：在 `_extract_one` 里集中校验，不要散落到多个分支。
3. **临时载荷表**：proposal 创建时存 `proposal_id → payload`，`approve` 后落盘即删；避免 zip 在文件系统到处散落。
4. **GitHub 路径与 upload 路径复用同一套 `_finalize_install`**：行为一致，不写两份落盘逻辑。
5. **不绕签名 / 校验**：本地 zip 是用户亲手上传，绕过 `_verification()` 是合理的（人工确认代替）；但 GitHub 路径仍然全跑。

---

## 六、相关坑

- [[2026-08-08-pitfalls-06-two-skill-lifecycles-divergence]] · 这次的 `propose_uploaded_zip` 复用 prompt skill 的 propose→approve 框架；两套 lifecycle 对齐后，upload 路径几乎免费搭车。
- [[2026-08-08-pitfalls-01-python-sqlite3-context-rollback]] · 新增的 `skill_install_proposal_payloads` 表写入时也要注意「先写后抛」——别在临时载荷写入路径上又踩一遍回滚坑。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · `workbench.skill_install_from_zip` 走的是统一 capability 注册模式，复用而非另起炉灶。