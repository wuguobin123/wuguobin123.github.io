---
title: "小薇 Agent 运行时参考：Turn、Session 与恢复"
date: "2026-08-31"
description: "参考小薇 Agent loop 的 Turn、Step、Tool 事件、请求头、seed boundary、冷恢复、Fork、Workflow 与 Subagent owner。"
tags: [小薇, Agent Loop, Session, 恢复]
draft: false
---

> **小薇技术篇 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · [04 插件架构](/posts/2026-08-31-xiaowei-04-plugin-architecture/) · [05 双 Host](/posts/2026-08-31-xiaowei-05-desktop-dual-host/) · **06 Agent 运行时** · [07 工具与产物](/posts/2026-08-31-xiaowei-07-tools-skills-artifacts/)

![Agent Loop 与 Session 事件日志](/images/2026-08-31-xiaowei-series/06-agent-runtime-sessions.png)

[打开可交互 HTML 图](/images/2026-08-31-xiaowei-series/06-agent-runtime-sessions.html)

我第一次把 Agent 任务从头到尾画出来时，发现“模型回了一段话”这个描述太粗了。一次真实任务包括输入领取、模型请求、若干工具、等待审批、追加消息和可能的重启。没有事件日志，恢复只能依赖猜测。

小薇沿用 Harness 的 Turn、Step 和 Session 模型，让每个可见变化有记录，让 Workflow 和 Subagent 的长任务有独立生命周期。

## 背景：一次请求不足以承载长任务

一个 Agent 可能先读规则，再调用搜索，等待用户批准写文件，启动子任务，最后生成 Artifact。中途网络断开或桌面重启并不罕见。若只保存最终答案，无法知道工具是否执行、哪一步被取消、恢复后应该从哪里继续。

UI 可以丢帧、重连或重新挂载，不能决定 Session 是否已提交；判断必须来自 Host 事件和持久化结果。

## 目标与非目标：记录事实，不保存幻觉

输入来自 inbox 和已记录的请求头；输出是 assistant 消息、工具结果、下一步状态和持久事件。UI 文本不能作为 loop 的输入来源。

恢复只能使用能校验的 JSON、序号和 owner；未知必需事件拒绝恢复。取消、拒绝、超时和部分流都要有明确结果，不能靠 spinner 推断。

目标是定义 Turn/Step/Tool 的生命周期，保存模型可见输入和结果，支持冷恢复与 Fork，并让 Workflow、Subagent 的状态可以观察和停止。

非目标是把每一项 UI 状态写进核心日志，也不是保存一个可随意修改的“当前消息数组”。UI 的 pending card、spinner 和折叠状态可以单独投影；只有影响模型请求或恢复判断的事实才进入 Session 事件。

## 方案设计：Turn、Step、Tool 三个尺度

### 调用链

`turn/start` → claim inbox → `agent/pre-step` → `step/start` → `user/message` → `agent/request` → LLM chunks → `tool/call` → 工具流水线 → `tool/result` → `step/end` → `turn/end`。工具欠账或新输入会产生下一 Step。

### 请求头

`request/header` 保存模型配置、适配器默认值、系统提示词和工具 schema；`request/context` 保存 provider、model、context window。它们让请求可以从日志重建。

一个 Step 是一次模型请求以及它发起的工具执行。一个 Turn 从领取首条输入开始，到没有待处理工作时结束。流程通常从 `turn/start` 开始，经过 `agent/pre-step`，产生 `step/start`、`user/message`、`agent/request`、assistant 流和 Tool 事件，再以 `step/end`、`agent/turn-stopping`、`turn/end` 收束。

首条输入被拒绝或改写为空，仍会留下没有 Step 的 Turn。这个细节让“用户提交过，但策略拒绝了”与“用户从未提交”可区分。工具结果或 inbox 新消息可能继续推动下一 Step。

## 详细设计：append-only 日志与恢复

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

## QA 与上线验收：从日志证明行为

先提交无工具 prompt，再提交含两个工具的 prompt，检查事件顺序和 call id。取消流式输出，检查 `interrupted`。重启 Host 后恢复同一 Session，再从边界 Fork，比较父子日志。

Workflow 检查 start、phase、agent-start/end 和唯一 end；Subagent 检查 prompt、结果、失败、interrupt 和资源 owner。不能把“进程启动”记录成“任务完成”。

先跑一个无工具 Turn，检查 start、user/message、assistant/message、end。再跑一个包含两次工具的 Step，验证 call/result 成对出现，原始参数保持不变，失败也有结果。取消流式响应时，检查已交付前缀带 `interrupted`，未派发工具调用不被伪造。

随后重启 Host，读取同一 Session 并重建请求头；再从一个边界 Fork，确认父日志不被改写。Workflow 要检查 `workflow/start`、phase、agent-start/end 和唯一的 `workflow/end`；Subagent 要检查创建、结果、失败和 interrupt 的 owner。

## 踩坑：把投影当真源

### 失败语义

模型可见内容未写 Session 时，恢复必须拒绝或明确缺失，不能补猜。未识别且没有 `ignorable: true` 的事件不得静默跳过；取消中断只记录实际交付的文本。

|现象|检查|处理|
|---|---|---|
|恢复少消息|`SessionEventMap` 与 seq|查缺失事件|
|UI 显示已完成|`turn/end`|以日志为准|
|子任务悬挂|Workflow/Subagent end|补取消与 owner 传播|

最典型的错误是只在 UI 保存 assistant 文本。断线重连时 UI 可能先显示结果，但 Host 没有 `assistant/message`；下一次请求就会丢上下文。修复后所有模型可见内容都从 Session 事件派生。

另一个错误是把 Workflow 的“已启动”显示成“已完成”，或把 Subagent 的进程存在当成任务成功。每个长任务都要有明确的 end reason 和失败传播；父任务收到的是结构化事实，不是乐观文案。

压缩也不能直接删旧事件。压缩需要自己的 start、summary、end 记录，恢复时知道摘要从哪里来；请求头变化也必须写完整快照，不能仅依赖一份未记录的 diff。

## 认知迭代：先定义事件，再定义页面

Session 是追加日志，不是可编辑消息数组；todo 等 UI 状态只有专门事件才持久。压缩必须留下 start、summary、end，不能直接删除旧事实。

新增模型输入先扩展事件类型，新增长任务先定义终止原因和恢复点，再实现 UI。每次提交都附带一次冷恢复和一次失败重放证据。

## 参考：事件驱动故障定位

按 `turn/start`、`step/start`、`agent/request`、`tool/call`、`tool/result`、`step/end`、`turn/end` 顺序查日志。缺哪一段，就定位到对应生命周期，而不是从页面猜原因。

### 运行命令

在测试组合中打印事件 type、seq、turn、step 和 callId；确认 seq 连续、payload 可 JSON 序列化、请求头能折叠。生产日志只记录必要元数据，不输出凭证。

把一次完整样例保存成可读 transcript：输入、请求头摘要、assistant chunk 数量、工具名称、结果错误码和结束原因都来自事件，而不是手工拼写。重放时不重新调用真实模型，只比较投影结果和事件引用，避免网络波动掩盖日志问题。

对于恢复失败，先区分格式失败和业务失败。格式失败包括未知必需事件、非连续 seq、不可序列化的 meta、错误的请求头快照；业务失败包括工具拒绝、Provider 错误和用户取消。前者应停止恢复并报告原因，后者应保留已记录的 Turn 结果并允许后续工作继续。

Workflow 与 Subagent 的测试还要覆盖“父任务先结束”和“子任务先结束”两种顺序。父任务结束不能抹掉仍在运行的子任务，子任务结束也不能自动伪造父任务成功；系统要根据 owner 和 end reason 处理未收束的工作。

请求头快照还应记录模型、Provider、reasoning effort 和采样参数。只保存一段 assistant 文本，无法解释同一 Session 为什么在恢复后选了另一条路由。`request/context` 的容量字段属于路由元数据，不能被误写成用户输入，也不能参与不相关的 header equality 比较。

实际排障时，同时查看持久化 cursor 和内存 Session cursor。两者不一致时先停写并保存现场，再判断是 checkpoint 尚未完成还是出现重复 owner；直接再次创建同 id Session 可能把真实的冲突覆盖成更难读的错误。

### seed boundary 的含义

Session 构造器从恢复、Fork 或 replay 载入的前缀属于 seed。`session/end-seed` 是日志中的边界标记，表示后续事件由当前生命周期产生；它不是“所有 writer 都已停止”的全局信号，也不是一个 checkpoint 事件。恢复器应定位存储历史中最后一个边界，不能在每次打开未变更 Session 时重复追加。

### checkpoint 与 whenIdle

Turn 边界不会等待持久化 flush。`dsh-session-checkpoint-policy` 负责每次请求的耐久检查点；需要读取存储结果的消费者，应在 `whenIdle()` 后自行等待并 flush。这样可以区分“loop 已经空闲”和“后端已经把事件写稳”，避免把内存完成误报为磁盘完成。

### unknown event 处理

事件读取器遇到未知 type 时，缺少 `ignorable: true` 必须拒绝重建；只有纯信息事件可以明确标记可忽略。这个默认值保护了未来事件对历史解释的影响。测试要同时覆盖未知必需事件被拒绝，以及未知可忽略事件被安全跳过。

### owner 与终止关系

Workflow 的 start/end、Subagent 的 start/result/interrupt 都应携带可追踪 owner。父 Turn 结束不自动让子任务成功，子任务结束也不自动提交父 Turn；恢复时按 owner 和终止原因决定是否续跑。资源位置和 Session owner 还要在双 Host 场景中一起校验。

一个合格的恢复报告应列出最后已确认的 `seq`、最后完整的 `request/header`、未闭合的 Turn/Step、未完成的 Tool call，以及 checkpoint 是否已 flush。这样运维可以区分“事件已经写入但 UI 未同步”和“事件根本没有落盘”，后续动作也不会误创建第二个 Session。

Runtime 设计先列生命周期和持久事件，再做 UI 投影；先写恢复测试，再写重连体验。Spinner、卡片和任务列表只是同一组事实的不同读法。

我现在评审一项新能力会问四个问题：模型看见了什么，哪个事件记录它，重启后如何重建，失败由谁拥有。回答清楚后，Workflow 和 Subagent 才能安全叠加，Agent loop 也不需要为每种业务写一套特殊分支。恢复报告还应注明读取的是本机还是云端资源，并记录 owner 与 cursor，避免合法的同名 Session 被错误合并。
