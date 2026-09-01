---
title: "小薇技术复盘 06：一次 Agent 任务怎样真正保存下来"
date: "2026-08-31"
description: "复盘小薇为什么没有把聊天消息数组当作任务记录，以及 Turn、Step、工具事件和追加日志怎样支撑恢复与 Fork。"
tags: [小薇, Agent Loop, Session, 恢复]
draft: false
---

> **小薇技术篇 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · [04 插件架构](/posts/2026-08-31-xiaowei-04-plugin-architecture/) · [05 双 Host](/posts/2026-08-31-xiaowei-05-desktop-dual-host/) · **06 Agent 运行时** · [07 工具与产物](/posts/2026-08-31-xiaowei-07-tools-skills-artifacts/)

![Agent Loop 与 Session 事件日志](/images/2026-08-31-xiaowei-series/06-agent-runtime-sessions.png)

[打开可交互 HTML 图](/images/2026-08-31-xiaowei-series/06-agent-runtime-sessions.html)

这张图把聊天页背后的四个对象分开：Inbox 接收输入，Agent Loop 推进 Turn 和 Step，Session Event Log 保存事实，Workflow 与 Subagent 承接更长的任务。页面只是这些状态的投影。

我第一次把 Agent 任务从头到尾画出来时，发现“模型回了一段话”这个描述太粗了。一次真实任务包括输入领取、模型请求、若干工具、等待审批、追加消息和可能的重启。没有事件日志，恢复只能依赖猜测。

小薇沿用 Harness 的 Turn、Step 和 Session 模型，让每个可见变化有记录，让 Workflow 和 Subagent 的长任务有独立生命周期。

## 消息数组为什么会在重启时失效

一个 Agent 可能先读规则，再调用搜索，等待用户批准写文件，启动子任务，最后生成 Artifact。中途网络断开或桌面重启并不罕见。若只保存最终答案，无法知道工具是否执行、哪一步被取消、恢复后应该从哪里继续。

UI 可以丢帧、重连或重新挂载，不能决定 Session 是否已提交；判断必须来自 Host 事件和持久化结果。

后来我给自己定了一条很硬的规则：模型看见的内容，日志里也必须找得到。取消、拒绝、超时和只返回一半的流，都要留下明确结果，不能靠页面上的 spinner 推断。

## 一条 Turn 怎样拆成 Step 和 Tool

### 调用链

`turn/start` → claim inbox → `agent/pre-step` → `step/start` → `user/message` → `agent/request` → LLM chunks → `tool/call` → 工具流水线 → `tool/result` → `step/end` → `turn/end`。工具欠账或新输入会产生下一 Step。

### 请求头

`request/header` 保存模型配置、适配器默认值、系统提示词和工具 schema；`request/context` 保存 provider、model、context window。它们让请求可以从日志重建。

一个 Step 是一次模型请求以及它发起的工具执行。一个 Turn 从领取首条输入开始，到没有待处理工作时结束。流程通常从 `turn/start` 开始，经过 `agent/pre-step`，产生 `step/start`、`user/message`、`agent/request`、assistant 流和 Tool 事件，再以 `step/end`、`agent/turn-stopping`、`turn/end` 收束。

首条输入被拒绝或改写为空，仍会留下没有 Step 的 Turn。这个细节让“用户提交过，但策略拒绝了”与“用户从未提交”可区分。工具结果或 inbox 新消息可能继续推动下一 Step。

## 追加日志如何撑起恢复和 Fork

### 事件表

|事件|持久含义|恢复用途|
|---|---|---|
|`user/message`|模型可见用户内容|重建历史|
|`assistant/chunk`|流式片段|回放 UI|
|`assistant/message`|完整输出与 usage|派生历史|
|`tool/result`|单一工具结果|继续下一步|

### Fork 与恢复

恢复加载日志并折叠最新请求头；Fork 读取边界并创建新 Session，不改父日志。创建时记录的插件选择随恢复和 Fork 延续，避免新安装改变旧任务语义。

Session 是仅追加的 `SessionEvent` 日志，`seq` 单调递增，`time` 记录时间。`deriveMessages()` 从事件投影模型历史，原始 `assistant/chunk` 保留流式回放。`tool/call` 记录工具名、call id 和模型原样参数；`tool/result` 记录单一模型可见结果。

请求头也要记：系统提示词、工具 schema、模型配置和适配器默认值进入 `request/header`，路由容量等元数据进入 `request/context`。因此一次模型请求不依赖某个临时内存对象，恢复可以折叠最新快照。

我遵守“模型可见即已记录”。新增注入内容就扩展 `SessionEventMap` 并从日志渲染，不能只塞进 UI store。未知事件默认拒绝恢复，只有明确 `ignorable: true` 才能跳过；静默丢掉未知必需事件会得到错误历史。

Fork 读取源 Session 的事件边界，创建新的持久资源；恢复则校验日志、重建请求头和生命周期。两者都不能用当前 UI 的列表替代源日志。账号或 Host 切换时，还要按资源位置找到正确的 Session。

## 我怎样确认一次运行真的结束

先跑一个无工具 Turn，检查 start、user/message、assistant/message、end。再跑一个包含两次工具的 Step，验证 call/result 成对出现，原始参数保持不变，失败也有结果。取消流式响应时，检查已交付前缀带 `interrupted`，未派发工具调用不被伪造。

随后重启 Host，读取同一 Session 并重建请求头；再从一个边界 Fork，确认父日志不被改写。Workflow 要检查 `workflow/start`、phase、agent-start/end 和唯一的 `workflow/end`；Subagent 要检查创建、结果、失败和 interrupt 的 owner。

## UI 状态曾经把我带错了方向

模型可见内容未写 Session 时，恢复必须拒绝或明确缺失，不能补猜。未识别且没有 `ignorable: true` 的事件不得静默跳过；取消中断只记录实际交付的文本。

|现象|检查|处理|
|---|---|---|
|恢复少消息|`SessionEventMap` 与 seq|查缺失事件|
|UI 显示已完成|`turn/end`|以日志为准|
|子任务悬挂|Workflow/Subagent end|补取消与 owner 传播|

最典型的错误是只在 UI 保存 assistant 文本。断线重连时 UI 可能先显示结果，但 Host 没有 `assistant/message`；下一次请求就会丢上下文。修复后所有模型可见内容都从 Session 事件派生。

另一个错误是把 Workflow 的“已启动”显示成“已完成”，或把 Subagent 的进程存在当成任务成功。每个长任务都要有明确的 end reason 和失败传播；父任务收到的是结构化事实，不是乐观文案。

压缩也不能直接删旧事件。压缩需要自己的 start、summary、end 记录，恢复时知道摘要从哪里来；请求头变化也必须写完整快照，不能仅依赖一份未记录的 diff。

## 这次以后，我先写事件再写页面

Session 是追加日志，不是可编辑消息数组；todo 等 UI 状态只有专门事件才持久。压缩必须留下 start、summary、end，不能直接删除旧事实。

新增模型输入先扩展事件类型，新增长任务先定义终止原因和恢复点，再实现 UI。每次提交都附带一次冷恢复和一次失败重放证据。

按 `turn/start`、`step/start`、`agent/request`、`tool/call`、`tool/result`、`step/end`、`turn/end` 顺序查日志。缺哪一段，就定位到对应生命周期，而不是从页面猜原因。

在测试组合中打印事件 type、seq、turn、step 和 callId；确认 seq 连续、payload 可 JSON 序列化、请求头能折叠。生产日志只记录必要元数据，不输出凭证。

把一次完整样例保存成可读 transcript：输入、请求头摘要、assistant chunk 数量、工具名称、结果错误码和结束原因都来自事件，而不是手工拼写。重放时不重新调用真实模型，只比较投影结果和事件引用，避免网络波动掩盖日志问题。

对于恢复失败，先区分格式失败和业务失败。格式失败包括未知必需事件、非连续 seq、不可序列化的 meta、错误的请求头快照；业务失败包括工具拒绝、Provider 错误和用户取消。前者应停止恢复并报告原因，后者应保留已记录的 Turn 结果并允许后续工作继续。

这里还有两个容易忽略的时间点。`session/end-seed` 只表示恢复或 Fork 载入的旧事件到此为止，并不表示所有写入已经完成；`whenIdle()` 也只表示 loop 暂时没有工作，不等于数据已经 flush 到存储。真正要交接或排障时，我会记录最后一个 `seq`、完整的 `request/header`、未闭合的 Turn/Step、未完成的 Tool call，以及 checkpoint 是否落稳。

这套记录比消息数组啰嗦，但它回答了我最在意的问题：重启以后，系统还能不能说清楚自己做过什么。做不到这一点，Agent 再聪明也只是一次性的演示。
