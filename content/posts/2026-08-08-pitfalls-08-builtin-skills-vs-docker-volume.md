---
title: "实战踩坑录 08 · 内置 skill 被 Docker 命名卷遮蔽：内置资源必须落在镜像层"
date: "2026-08-08"
description: "docker-compose 把 .agents/skills 挂成命名卷后，第一次启动写入的内容会覆盖后续 image 更新里的同名文件。想内置 skill？必须放独立目录 + Dockerfile COPY + deploy rsync include，避开命名卷。"
tags: [Docker, Skill, 部署, 命名卷, 内置资源]
draft: true
---

## 一、症状

把 `frontend-slides` 做成内置 skill，希望每次 image 升级都自动带上。部署后表现：

1. 镜像里 `builtin_skills/frontend-slides/` 有 SKILL.md + WORKBENCH.md + bold-template-pack。
2. 第一次启动容器，agent 能找到 `frontend-slides`。
3. 升级 image（`docker compose pull && up -d`），新版本里 `frontend-slides` 加了一个新功能（脚本 `extract-pptx.py` 升级）。
4. **重启后容器里 `frontend-slides` 还是旧版**——新加的功能不见。

运维反馈：「代码明明升级了，行为没变」。研发排查半天以为是缓存，最后才意识到是 docker-compose 命名卷把新文件盖住了。

---

## 二、根因

### docker-compose 当前写法

```yaml
# docker-compose.yml（原版）
services:
  app:
    build: .
    volumes:
      - prompt-skills:/app/.agents/skills     # ← 命名卷
      - ./skills:/app/skills:ro
      - ./plugins:/app/plugins:ro
```

`prompt-skills` 是个 **named volume**（不是 bind mount）：

```text
首次启动：
  - docker 检测到 /app/.agents/skills 不存在 → 创建命名卷 prompt-skills
  - 把 image 内 /app/.agents/skills 的内容复制到卷里（一次性）
  - 容器从此读写这个卷

后续启动 / image 升级：
  - 命名卷已经存在，image 内的同名目录不再被复制进来
  - 容器继续读写卷 → 旧内容继续存在
```

**根因**：named volume 的生命周期独立于 image，一旦首次挂载就保留下来，image 内的同名目录更新永远进不来。

### 资源类型 vs 部署语义

| 资源 | 语义 | 该放哪 |
|---|---|---|
| **image 升级必须跟新的内置**（frontend-slides 这类） | 代码的一部分 | image 层（`COPY builtin_skills`） |
| **用户态数据**（用户的 skill 安装记录） | 每用户独立 | named volume |
| **配置**（`.env`、nginx conf） | 部署相关 | bind mount 或 env |

混在一起就会出问题——`.agents/skills/` 当前同时承担「用户态 skill 安装目录」和「原本想放的 image 内置 skill」两个角色。

---

## 三、修复

### 步骤 1 · 把内置 skill 放到独立目录

```bash
mkdir -p builtin_skills/frontend-slides
cp -r .agents/skills/.overrides/frontend-slides/* builtin_skills/frontend-slides/
# 删 plugins/ 和 .claude-plugin/（1.9MB 重复 + Claude-Code 特定目录）
rm -rf builtin_skills/frontend-slides/plugins
rm -rf builtin_skills/frontend-slides/.claude-plugin
```

### 步骤 2 · 让 PromptSkillRegistry 同时扫两个目录

```python
# src/customer_service_ai/config.py
class Settings(BaseSettings):
    prompt_skill_directories: str = ".agents/skills,builtin_skills"
    #                 ↑ 顺序敏感：builtin_skills 写在前面，dedup 时内置优先
```

```python
# src/customer_service_ai/prompt_skills.py（已有逻辑，复用）
class PromptSkillRegistry:
    def __init__(self, dirs: list[str]):
        self._dirs = [Path(d) for d in dirs.split(",")]

    def reload(self):
        seen: dict[tuple, dict] = {}    # (tenant, actor, name) → first wins
        for d in self._dirs:
            for skill in self._scan(d):
                key = (skill.tenant, skill.actor, skill.name)
                if key not in seen:
                    seen[key] = skill
        self._skills = list(seen.values())
```

`builtin_skills` 列在前面 → 用户如果也装了同名 skill，内置版本胜出。

### 步骤 3 · Dockerfile / docker-compose / deploy script

```dockerfile
# Dockerfile
COPY skills ./skills
COPY plugins ./plugins
COPY builtin_skills ./builtin_skills      # ← 新增
COPY .agents ./.agents                    # 容器启动时仍可写
```

```yaml
# docker-compose.yml
services:
  app:
    build: .
    environment:
      APP_PROMPT_SKILL_DIRECTORIES: /app/builtin_skills,/app/.agents/skills
                                                    # ↑ 内置在前，用户态在后
    volumes:
      - prompt-skills:/app/.agents/skills           # 只挂用户态目录
      - ./builtin_skills:/app/builtin_skills:ro      # 镜像层 + bind mount 双保险
      - ./skills:/app/skills:ro
      - ./plugins:/app/plugins:ro
```

bind mount `./builtin_skills:ro` 让开发机改文件能直接生效；生产里镜像已经 COPY，bind mount 不写就当冗余保险。

```bash
# scripts/deploy_production.sh
rsync -av --include='scripts/' --include='skills/' --include='plugins/' \
      --include='builtin_skills/' --exclude='*' ./ "$REMOTE:/app/"
# ↑ 把 builtin_skills 加进 include 列表
```

### 步骤 4 · 清理 `.agents/skills/.overrides/frontend-slides/`

旧的内置副本（来自早期「override」机制）现在没用了，删掉避免混淆：

```bash
rm -rf .agents/skills/.overrides/frontend-slides/
rm -rf .agents/skills/.scoped/*/frontend-slides/
rm -rf .agents/skills/.trash/*/frontend-slides/      # 如果有
```

`.gitignore` 已经覆盖 `.overrides/` `.scoped/` `.trash/`，所以这些目录本来就是 runtime 状态，删掉是卫生动作。

---

## 四、验证

```bash
# 1. 内置可发现
$ PYTHONPATH=src .venv/bin/python -c "
from customer_service_ai.prompt_skills import PromptSkillRegistry
r = PromptSkillRegistry(['.agents/skills', 'builtin_skills'])
r.reload()
print([s.name for s in r.list() if s.name == 'frontend-slides'])
"
['frontend-slides']

# 2. image 升级能带进来
$ docker compose build --pull
$ docker compose up -d
$ docker compose exec app ls /app/builtin_skills/frontend-slides/
# 应该看到新版本的文件，包括升级后的 scripts/extract-pptx.py

# 3. 用户态目录仍然独立
$ docker compose exec app touch /app/.agents/skills/my-user-skill/SKILL.md
$ docker compose restart app
$ docker compose exec app ls /app/.agents/skills/my-user-skill/
# 应该还在
```

---

## 五、可复用清单 · 内置资源 vs 用户态数据

| 决策点 | 判断 | 部署语义 |
|---|---|---|
| 这个目录是「image 升级必须更新」的资源吗？ | 是 | image 层（`COPY` + bind mount `:ro`） |
| 这个目录是「用户 / 部署实例的可写状态」吗？ | 是 | named volume 或 bind mount（可写） |
| 两类混在同一个目录？ | 拆开 | 加新目录，调整 `prompt_skill_directories` 顺序 |

每次加新的「内置」资源前过一遍：

1. 想清楚它是「代码」还是「数据」。
2. 代码 → image 层；数据 → 命名卷。
3. 既有目录能分就分；不能分就重新组织。
4. 写一个 smoke test 验证 image 升级后内容确实更新了（这是发现命名卷遮蔽的唯一可靠方法）。

---

## 六、相关坑

- [[2026-08-08-pitfalls-02-macos-app-deploy-gatekeeper-mlx]] · macOS 部署是「App 自身的 quarantine 不让覆盖」，这里是「Docker 命名卷不让覆盖」——同一类「资源被某层缓存/挂载钉死」问题。
- [[2026-08-08-pitfalls-06-two-skill-lifecycles-divergence]] · 内置 skill 的特殊 lifecycle（无需 install / 无法 uninstall）跟普通 prompt skill 完全不同；管理面要单独处理。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · 内置 skill 的 capability 注册模式与运行时一致——只是 `_BUILTIN_IDS` 集合里永远包含它，不需要走 propose 流程。