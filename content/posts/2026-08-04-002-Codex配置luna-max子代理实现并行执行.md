---
标题: Codex 配置 luna_worker/sol_worker 子代理：luna-max 并行执行工作流
日期: 2026-08-04
标签: [Codex, 子代理, 多Agent, luna-max, 工作流]
---

# Codex 配置 luna_worker/sol_worker 子代理：luna-max 并行执行工作流

## 摘要

按 @Saccc_c 推文方法，在本机 Codex 中配置了「sol 做方案设计、luna-max 并行执行」的子代理分工：`~/.codex/agents/luna-worker.toml`（gpt-5.6-luna + max）和 `sol-worker.toml`（gpt-5.6-sol + max）。实测发现当前 Codex CLI 0.145.0 的二进制中并没有 `~/.codex/agents/` 的原生加载路径，该目录机制可能来自更新版本；因此同时向 `~/.codex/AGENTS.md` 写入调度说明，让当前版本立即按 luna-max 派生子代理，TOML 文件则作为向前兼容的定义保留。

## 背景：什么是「无限子弹」

推文思路：Codex 主代理派生的子代理如果默认继承主模型，成本和速率都受主模型约束；把执行型子代理换成更快更便宜的模型（`gpt-5.6-luna`）并开到 `max` 推理强度，就能大量并行处理边界明确的小任务——即「无限子弹」。分工是：

- 复杂任务先由强模型（`gpt-5.6-sol`）做方案设计；
- 方案拆成独立小任务后，交给 `luna-max` 子代理并行执行。

## 本机适配前的关键核实（Codex CLI 0.145.0）

照抄配置前先做了四步核实，结论决定了两处适配：

1. **模型可用**：`~/.codex/models_cache.json` 中 `gpt-5.6-luna`（Fast and affordable agentic coding model）与 `gpt-5.6-sol`（Latest frontier agentic coding model）均存在，且 `supported_reasoning_levels` 都含 `max`。
2. **多代理已启用**：`codex features list` 显示 `multi_agent = stable/true`（`multi_agent_v2` 默认关闭）。主代理通过 `spawn_agent` 工具派生子代理，工具描述明确支持模型与推理强度覆盖（"Available model overrides (optional; inherited parent model is preferred)"）。
3. **`~/.codex/agents/` 未被当前版本读取**：对 0.145.0 平台二进制做字符串分析，没有发现该目录的任何加载路径引用。推文的机制可能来自更新版本的 Codex。按原样创建 TOML 是无害且向前兼容的，但不能指望当前版本立即读取。
4. **`~/.codex/AGENTS.md` 存在但为空**：这是 Codex 每次会话必加载的全局指令文件，是确保主代理「知道如何按 luna-max 调度子代理」的可靠机制。

## 最终配置

### 1. `~/.codex/agents/luna-worker.toml`（推文原样）

```toml
name = "luna_worker"
description = "Fast worker for clear, narrowly scoped, and repeatable tasks."
developer_instructions = """
Handle the assigned task strictly within its stated scope.
Work independently and use appropriate tools when needed.
Verify the result when practical.
Do not make unrelated changes.
Return a concise summary containing the result, relevant file paths, verification performed, and any important caveats.
"""
model = "gpt-5.6-luna"
model_reasoning_effort = "max"
```

### 2. `~/.codex/agents/sol-worker.toml`（补全工作流的另一半）

```toml
name = "sol_worker"
description = "Solution architect for complex tasks: analyzes requirements and designs structured implementation plans."
developer_instructions = """
Analyze the assigned problem deeply and independently.
Survey the relevant code, constraints, and risks before proposing anything.
Produce a structured, actionable implementation plan: clear steps, target files, interfaces, edge cases, and a verification strategy.
Split the plan into small, independent, well-scoped work items suitable for parallel execution by luna_worker subagents.
Do not implement the plan yourself unless explicitly asked.
Return the plan concisely, with any open questions or assumptions flagged.
"""
model = "gpt-5.6-sol"
model_reasoning_effort = "max"
```

### 3. `~/.codex/AGENTS.md` 调度说明（当前版本立即生效的关键）

原文件为空。写入内容要点：

- `sol_worker`：复杂任务的方案设计者，`gpt-5.6-sol` + `max`，产出已拆分为独立小任务的结构化实施方案。
- `luna_worker`：边界明确、可重复的小任务执行者，`gpt-5.6-luna` + `max`；严格限定范围、独立执行、可行时验证、简洁汇报（结果/文件路径/验证情况/注意事项）。
- 调度规则：派生子代理时传入对应的模型与推理强度覆盖，并把工作方式作为子代理指令；多个独立小任务并行派发；复杂任务走「sol 设计 → 审阅拆分 → luna 并行执行」流程。

## 使用方式

Codex 新会话中直接说：

> 请使用 luna_worker 子代理完成以下任务：[任务]。等待子代理完成后，检查并汇总它的结果。

复杂任务则先请 sol_worker 出方案，审阅后拆成互不重叠的小任务并行派给 luna_worker。

## 注意事项与边界

- TOML 文件是否被原生加载取决于 Codex 版本；`AGENTS.md` 调度说明才是当前 0.145.0 的生效机制。两者内容保持一致，未来版本原生读取 TOML 时无缝衔接。
- 子代理指定 `gpt-5.6-luna` 等 OpenAI 内置模型时走 OpenAI 侧鉴权（本机已有 ChatGPT OAuth 登录），与主模型 provider（本机为 MiniMax）无关。
- 「无限子弹」是形象说法：并行子代理的用量仍受账号额度与速率限制约束；`spawn_agent` 的官方建议也是「继承父模型优先」，只在明确需要时覆盖。
- 系统 python3 若无 `tomllib`（3.11 以下），验证 TOML 需换其他解析方式。

## 相关页面

- [[2026-08-04-001-Codex先调研后编码省token工作流]]：另一条 Codex 提示词工作流实践
- [[2026-07-11-019-Codex与Claude-Code使用最佳实践]]：Codex 长任务、Subagent、Worktree 官方机制
- [[2026-07-14-006-OpenClaw与Claude-Code的Agent模块构建拆解]]：子 Agent 模块的源码级拆解
- [[../概念/多Agent与Subagent设计|多Agent 与 Subagent 设计]]

## 来源

- [[../../资料/来源/2026-08-04-Saccc-c-Codex子代理luna-max配置方法|Saccc_c：Codex 配置 luna_worker 子代理（luna-max 无限子弹）]]
