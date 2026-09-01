---
title: "实战踩坑录 09 · Codex `~/.codex/agents/*.toml` 当前版本不自动加载：用 AGENTS.md 写死调度约定"
date: "2026-08-08"
description: "推文里说把 luna-worker.toml 放进 ~/.codex/agents/ 就能注册子代理。实测 0.145.0 二进制里这个目录根本不在加载路径里。要让主代理真的知道怎么派发，必须在 AGENTS.md 里把调度约定写明白。"
tags: [Codex, 子代理, Multi-Agent, TOML, 工作流, 提示词]
draft: true
---

## 一、症状

照推文的方法配置 luna-worker 子代理：

```bash
mkdir -p ~/.codex/agents
cat > ~/.codex/agents/luna-worker.toml <<'EOF'
name = "luna_worker"
description = "..."
model = "gpt-5.6-luna"
model_reasoning_effort = "max"
developer_instructions = "..."
EOF
```

然后让 Codex 主代理执行：

```
请使用 luna_worker 子代理列出当前目录的文件，等它完成，汇总它的结果。
```

期望：主代理派发 `gpt-5.6-luna` + reasoning `max` 的子代理，跑完汇总。
实际：主代理根本不知道 `luna_worker` 是什么，直接自己跑 ls，或者拒绝。

---

## 二、根因

本机 Codex CLI 0.145.0 实测：

```bash
$ codex --version
codex-cli 0.145.0

$ strings $(which codex) | grep -i "agents/" | head -5
# 无任何 ~/.codex/agents/ 路径加载痕迹
```

推文里的机制可能在更新版本的 Codex 中存在，0.145.0 二进制里这个目录**完全没有加载路径**。

进一步验证：

```bash
$ ls ~/.codex/models_cache.json | head -1
$ jq '.["gpt-5.6-luna"]' ~/.codex/models_cache.json
{
  "id": "gpt-5.6-luna",
  "name": "Fast and affordable agentic coding model",
  "supports_reasoning_effort": true
}
# 模型可用

$ codex features list | grep -A 2 multi_agent
multi_agent   stable/true
# 多代理功能已启用

$ jq '.tools[] | select(.name == "spawn_agent")' ~/.codex/tools_schema.json
{
  "name": "spawn_agent",
  "description": "... Available model overrides (optional; inherited parent model is preferred)..."
}
# spawn_agent 工具支持 model override 和 reasoning effort override
```

也就是说：

1. `~/.codex/agents/*.toml` 当前不被二进制读取（无效）。
2. `spawn_agent` 工具本身是稳定可用的，能传 model override。
3. 主代理能不能正确派发，取决于它「知不知道」luna_worker 是什么角色、用什么模型。

**根因**：当前版本下，`~/.codex/agents/` 目录是**预留**机制，不是**生效**机制。要让派发生效，必须在 `~/.codex/AGENTS.md`（每次会话必定加载的全局指令文件）里把约定写明白，主代理才能正确调度。

---

## 三、修复

### 步骤 1 · 仍然创建 TOML 文件（无害 + 向前兼容）

```bash
mkdir -p ~/.codex/agents
cat > ~/.codex/agents/luna-worker.toml <<'EOF'
name = "luna_worker"
description = "Fast executor for narrowly-scoped tasks"
model = "gpt-5.6-luna"
model_reasoning_effort = "max"
developer_instructions = """
You are a fast executor. Scope is narrow and well-defined; produce a result,
file paths, validation steps, and caveats. No design work — that belongs to sol_worker.
"""
EOF

cat > ~/.codex/agents/sol-worker.toml <<'EOF'
name = "sol_worker"
description = "Architect for complex tasks; produces structured plan"
model = "gpt-5.6-sol"
model_reasoning_effort = "max"
developer_instructions = """
You design first. Produce a structured implementation plan: tech selection,
architecture, MVP scope, dev order. Hand off to luna_worker for execution.
"""
EOF
```

### 步骤 2 · 在 `~/.codex/AGENTS.md` 写死调度约定

```bash
cat > ~/.codex/AGENTS.md <<'EOF'
# 子代理调度约定

本会话默认有两个子代理角色。

## sol_worker
- 模型：gpt-5.6-sol
- 推理强度：max
- 定位：复杂任务的方案设计者
- 产物：结构化实施方案（技术选型 / 架构 / MVP / 开发顺序）

## luna_worker
- 模型：gpt-5.6-luna
- 推理强度：max
- 定位：快速执行边界明确、可重复的小型任务
- 工作方式：
  - 严格限定范围
  - 独立执行（无依赖时与同类并行）
  - 可行时验证（跑测试、看日志）
  - 简洁汇报：结果 / 文件路径 / 验证情况 / 注意事项

## 调度方式
- 复杂任务 → 先 spawn_agent sol_worker 设计
- 方案确认后 → spawn_agent luna_worker（多个独立任务可并行）
- spawn_agent 调用必须显式传入 model override + reasoning effort override
- 不要把 sol_worker 用作执行者；不要让 luna_worker 做架构设计
EOF
```

### 步骤 3 · 验证主代理真的派发到 luna_worker

新开 Codex 会话：

```
请使用 luna_worker 子代理完成以下任务：
1. 列出当前目录所有 .md 文件
2. 每个文件统计行数
3. 输出一个 markdown 表格：文件名 / 行数

完成后请汇总结果。
```

观察点：

- 主代理是否调用 `spawn_agent` 并传 `model="gpt-5.6-luna"`、`reasoning_effort="max"`。
- 子代理返回的内容是否带「luna_worker 报告」的措辞（表明它读到了 developer_instructions）。
- 输出格式是否是表格（luna 的 developer_instructions 没要求表格，所以可能只是列表——这是预期）。

---

## 四、验证脚本（可选）

```bash
$ python3 -c "
import tomllib
for name in ['luna-worker', 'sol-worker']:
    with open(f'$HOME/.codex/agents/{name}.toml', 'rb') as f:
        cfg = tomllib.load(f)
    assert cfg.get('model'), f'{name} 缺 model'
    assert cfg.get('model_reasoning_effort') == 'max', f'{name} reasoning effort != max'
    print(f'{name} OK:', cfg['name'], cfg['model'])
"
luna-worker OK: luna_worker gpt-5.6-luna
sol-worker OK: sol_worker gpt-5.6-sol
```

---

## 五、可复用清单 · 子代理 / 多代理调度

| 决策 | 推荐做法 |
|---|---|
| 子代理的「配置」 | 写 TOML + AGENTS.md 双轨。TOML 是向前兼容，AGENTS.md 是当下生效。 |
| 主代理怎么知道派给谁？ | `AGENTS.md` 写明角色 + 模型 + 工作方式 + 边界；不要让主代理自己推断。 |
| 多个独立任务 | 并行 spawn_agent；不要串行。 |
| model override / reasoning override | 每次显式传，不要让主代理「按需默认」——避免它临时改主意。 |
| 验证派发是否生效 | 在 spawn_agent 调用前后打 log（看 prompt 里 model 字段）；或在 developer_instructions 里要求子代理自报家门。 |
| TOML 不生效？ | 用 `strings $(which codex) | grep agents/` 看二进制里有没有加载路径；没有就靠 AGENTS.md。 |

---

## 六、相关坑

- [[2026-08-08-pitfalls-12-multi-cli-orchestrator-from-zero]] · 升级到「多 CLI 编排器」时，AGENTS.md 的角色约定会被状态机驱动的工作流取代，但子代理角色划分（设计者 vs 执行者）的思路是一致的。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · Codex 子代理强调「model + reasoning + instructions」，工作台 AI agent 强调「capability + risk_level + input_model」——两边抽象层级不同，但都是「把执行单元的边界写清楚」。