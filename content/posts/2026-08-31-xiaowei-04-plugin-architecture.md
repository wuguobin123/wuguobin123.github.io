---
title: "小薇插件架构指南：Cordis、Profile 与能力分层"
date: "2026-08-31"
description: "参考小薇 bundle 与 preset，掌握 Cordis 插件树、能力分层、patch 覆盖、realm、inject、effect/disposer，以及从配置到工具调用的定位方法。"
tags: [小薇, Harness, Cordis, 插件架构]
draft: false
---

> **小薇技术篇 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · **04 插件架构** · [05 双 Host](/posts/2026-08-31-xiaowei-05-desktop-dual-host/) · [06 Agent 运行时](/posts/2026-08-31-xiaowei-06-agent-runtime-sessions/) · [07 工具与产物](/posts/2026-08-31-xiaowei-07-tools-skills-artifacts/)

![小薇的插件、Profile 与能力分层](/images/2026-08-31-xiaowei-series/04-plugin-profile-seam.png)

[打开可交互 HTML 图](/images/2026-08-31-xiaowei-series/04-plugin-profile-seam.html)

我做小薇架构复盘时，首先要回答的是要不要重新造一套 Agent 框架，而非某个 API 怎么写。仓库里已经有模型适配、会话、工具和循环，桌面端又有本机 Host。重新实现会同时复制状态、审批和恢复逻辑，出问题时很难判断是产品代码还是基础设施代码。

我的选择是复用 DeepSeek Harness 的 Cordis 插件树，把小薇的差异放进 bundle、Profile、Preset 和 Provider。这样做的前提是把边界说清楚：下面写的是代码与规格里的工程事实，不把“有接口”写成“已上线”。

> **事实状态**：仓库文档把模型、工具、Session、Agent loop 都定义为插件；小薇的 `cordis.patch.yml` 负责产品组合。规格标为 `approved` 的能力仍需单独验收，知识库 seam 也不能推出小薇已经上线 RAG。

## 背景：一体化应用很快会卡住

### 读者与前置知识

本文面向需要维护 Agent 组合和插件配置的工程师。读者只需了解 TypeScript、依赖注入和 YAML；不要求先读 Cordis 源码。文中的 `ctx` 是运行时共享上下文，`inject` 是插件声明的服务依赖。

### 术语与对象

|对象|职责|定位方式|
|---|---|---|
|Bundle|分发配置和挂载代码|`dsh.bundle`|
|Profile|具名组合|`dsh.profile`|
|Preset|一次 Agent 的能力选择|preset 文件|
|能力 seam（可替换接口）|Definition、Provider、Consumer 三角色|服务名与事件|

早期 Agent 可以把模型请求、工具函数和消息列表写在同一个服务里。需求增加后，几个变化会互相牵连：本地文件要换成远程沙箱，工具要加审批，模型要换 Provider，Session 要支持恢复，桌面还要把云端和本机结果放在一起。

如果每项变化都改主循环，测试会变成一条巨大的回归链。更麻烦的是，某个工具的安全规则可能被另一个工具复制一份，最后两份规则在拒绝条件上不一致。

我需要的是明确的装配位置，而非一个“万能插件市场”。Cordis 的共享 `ctx`、服务依赖和可撤销 effect 正好给出了这个位置。插件卸载时撤销注册，Provider 可以被替换，Consumer 不必知道实现来自哪个进程。每个 effect 都要有 disposer；没有 disposer 的监听、定时器或注册表写入会在重载后残留。

## 目标与非目标：先约束复用范围

### 输入与输出

输入是 bundle、patch、preset 和用户安装项；输出是可加载的 Cordis 树、Agent 请求头和可观测 Session 事件。配置错误必须在最早能判断的位置抛出。

### 权限与限制

Profile 不是账号授权。账号 owner、Host location 和审批策略分别约束数据与执行；一个可发现的 Skill 也不自动获得写文件权限。

这次设计目标有三项：让小薇保留 Harness 的 Session 与 Agent loop；让本机、云端和测试组合可以替换实现；让工具、Skill 和审批通过同一套事件与服务边界接入。

非目标同样重要。我没有把小薇描述成从零开发的框架，也没有因为目录里出现一个 Provider 就声称对应能力已经在生产可用。没有 `implemented` 验收记录的项目，只能写成设计、批准范围或开发中。

我还不把 Profile 当成账号权限系统。Profile 负责启动时挂载什么，Session 的 owner、资源路由和审批负责谁能使用什么。把这两件事混在一起，会让安装状态和授权状态失去区别。

## 方案设计：Bundle、Profile、Preset 三层装配

### 装载顺序

启动从空条目列表开始，叠加 Profile bundles，再应用 Profile patch、home patch 和命令行 overlay。后层按 id 替换完整 config 或插入新条目，不能假定 YAML 文件顺序就是服务启动顺序。

### 定位工具

我定位配置时先运行 `dsh --profile web --dump-config`，记录实际条目 id 和包名，再回到 patch 查来源。若只看源文件，容易漏掉 home patch 或命令行 overlay。

Bundle 是 Cordis 配置和挂载代码的分发格式。小薇 bundle 的 `cordis.patch.yml` 里能看到模型、账号服务、Artifact、Skill、Subagent、Workflow 和工具相关条目。Profile 叠加 bundle 后，Preset 再选择一次 Agent 实际拥有的服务、提示词和工具 schema。一个插件被装进树里，不代表它会进入当前 Session 的请求头；需要隔离的服务挂进独立 realm。

## 详细设计：用 seam 替换实现

### Definition 与 Provider

Definition 拥有接口、参数和事件语义；Provider 拥有执行位置、资源和失败转换。Provider 替换时，调用者只依赖服务接口，不复制远程分支。

### Consumer 与请求头

Consumer 注册模型工具和展示方法，工具 schema 只有在当前 Preset 选中且服务可用时才进入 `request/header`。安装条目存在但未进入请求头，不算当前能力。

我把一项能力拆成三种角色。Service Definition 声明服务接口和事件；Service Provider 实现本机或云端版本；Consumer 使用服务，面向模型时通常还会注册工具。只有三者一起设计，才称得上一个可替换能力 seam。

以 shell 为例，Consumer 只提交执行请求，Provider 可以通过本机 subprocess，也可以指向受限沙箱。工具的审批、超时和结果记录由统一事件处理。替换 Provider 时，Bash、PTY、文件系统与 LSP 可以继续共享执行世界，避免每个工具都写远程分支。

账号隔离还会影响插件选择。认证 principal 负责插件工厂修改；持久 Session 的 `ownerId` 决定 Skill 查询和会话写入。创建 Session 时记录可选插件选择，之后安装变化只作用于新 Session，恢复和 fork 继续采用历史选择。这是保证旧日志含义稳定的必要记录。

这里有一条实际检查路径：先找 patch 中的 id，再找 `name` 对应包；接着看包的 `inject`，确认服务 Provider 已挂载；最后检查 Preset 是否把工具 schema 加入请求头。任何一步缺失，都是“配置存在但能力不可用”。

## QA 与上线验收：怎样证明装配正确

### 组合验收

验收至少包括配置 dump、类型检查、注册 disposer、真实 Session、允许与拒绝工具调用、重启恢复和 Provider 替换。每项记录使用的 Profile、Preset、模型和工作目录。

### 状态闸门

`implemented` 才能描述已实现并有验收依据；`approved` 只说明批准范围。没有规格或真实运行证据时，我写“设计中”或“待验收”，不写上线。

先做配置树检查，确认 `dsh --dump-config` 中条目 id、依赖和 patch 顺序符合预期。再跑包级类型检查和单元测试，验证注册 disposer、事件 payload 与 fail-fast 配置错误。

产品验收要走真实组合：创建 Session，确认请求头包含预期工具 schema；执行一次允许调用和一次拒绝调用；重启后从 Session 日志恢复；再替换一个 Provider，检查 Consumer 行为不变。桌面端还要分别验证本机与云端资源 id 的归属。

我不会用“页面能打开”替代能力验收，也不会把 `status: approved` 当作发布结果。浏览器、账号搜索、知识库等都要按各自规格记录实现状态、测试范围和未完成项。

## 踩坑：安装记录不等于当前能力

### 注入缺失

插件实际读取 `ctx.tools` 却遗漏 `inject`，组合测试会出现 `cannot get property ... without inject`。修复要同时检查注入列表、manifest 和 preset，不能只给 mock 补字段。

### 隐式 fallback

未知服务或方法若静默换 Provider，Session 记录的权限和执行位置就无法解释。小薇组合要求缺失依赖直接失败，调用方再决定是否重试。

最容易误判的是“设置页看到了 Skill，所以模型一定能用”。实际上，Skill 目录清单、当前 Session 的 Preset、模型请求头中的 schema 是三个不同检查点。只证明第一项，会把 UI 投影当成运行时事实。

另一个坑是只检查 bundle 中有没有条目，却没有检查 Profile 的叠加顺序和 Preset 的最终选择。同一个包可能已经安装，却没有进入当前 Agent 的请求头。排查时必须看实际 dump 出来的插件树和 Session 记录，不能凭目录存在下结论。

还有一种诱惑是为兼容旧组合保留隐藏 fallback。小薇仍在基础建设期，未知方法和缺失 Provider 应尽早报错；静默切换到另一个能力会让 Session、权限和审计都难以解释。

## 认知迭代：少写主循环，多写装配事实

### 最佳实践

新增能力先写 Definition，再列 Provider 的执行地点和 Consumer 的模型输入；把可调参数放进 config，把安全不变量留在代码；所有注册返回 disposer。

### 结束检查

我提交前会保存 `dump-config`、请求头和一次恢复日志，确认没有改动其他 Profile。三份证据都能指向同一个包和版本，才认为装配可交接。

## 参考流程：从配置到一次调用

### E2E 步骤

1. 选择 Profile，执行 `dsh --profile web --dump-config`。
2. 找到目标 bundle 的 id、`name` 与 `inject`，确认 Provider 已挂载。
3. 选择 Preset，创建 Session，检查 `request/header` 的工具 schema。
4. 调用工具，观察 `tool/call`、策略事件和 `tool/result`。
5. 重启并恢复 Session；若替换 Provider，重复同一调用并比较结果语义。

### 故障排查表

|现象|优先检查|处理|
|---|---|---|
|配置没生效|patch 顺序与 id|看 dump-config，确认后层是否覆盖|
|工具未出现|Preset、inject、Provider|检查请求头和组合 manifest|
|恢复含义改变|Session 选择是否记录|固定创建时的插件选择|
|未知 RPC 被执行|分类表是否穷尽|补分类并保持 fail closed|

### 小薇 Profile 的使用方式

仓库源码可以证明 `packages/bundle/xiaowei` 与 `packages/bundle/xiaowei-local` 的 bundle 和 preset，但不能替当前机器证明 profile 注册名。因此命令写成 `dsh --profile <实际名称> --dump-config`；若本机已注册，可将占位符替换为 `xiaowei` 或 `xiaowei-local`。不要因为目录名存在就断言 CLI 一定能加载该名称。

### 从 dump 到 request/header

定位一个工具时，先在 dump 中找到 bundle 条目和最终 patch；再打开对应 preset，确认服务行的 realm、Provider 与 `inject`；创建 Session 后读取 `request/header`，检查工具 schema 是否出现；最后查 `tool/call`，确认模型真的发起调用。四个观察点分别回答“装载、选择、暴露、执行”，不要用其中一个替代其余三个。

### Patch 覆盖示例

patch 按 id 定位条目并替换整个 config。后层若只写了一个字段，不等于深合并旧 config，必须把需要保留的字段一起写出。命令行 overlay 的优先级高于 home patch；定位差异时保存每层输入和最终 dump，才能解释为什么某个 Provider 没有生效。

### 约束与排查

`inject` 是硬依赖时应声明，缺少服务应停在加载阶段；可选服务才通过 `ctx.get()` 判断。注册监听、服务和目录观察器必须返回 disposer。若重载后出现重复事件，先查 effect 是否可逆；若工具出现但调用报缺服务，查 realm 与 inject；若请求头没有 schema，查 Preset 而不是模型。

文档定位时应把四份证据放在同一份记录中：最终配置 dump、Preset 文件、请求头快照和工具调用事件。配置 dump 说明“树里有什么”，Preset 说明“Agent 选了什么”，请求头说明“模型看到了什么”，事件说明“实际执行了什么”。缺任何一份，都只能报告局部状态。

这次复盘后，我把架构评审的问题从“这个功能放哪段循环里”改成“它属于哪个 seam、由谁提供、谁消费、哪些事件必须记录”。这让代码变更的责任边界更短，也让测试可以直接命中 Provider、Consumer 和组合结果。

复用 Harness 不是偷懒，前提是复用已有事实模型，并补齐小薇自己的产品边界。新增能力时，先画 Bundle/Profile/Preset 三层，再写 Definition、Provider、Consumer，最后用实际请求和恢复日志证明它真的进入了会话。记录还应注明 Git 版本和工作目录，避免把另一个 checkout 的配置误当成当前产品。发布记录还要保留实际 profile 名称、preset 版本、验证时间和运行平台。

交接时一并保存命令输出、配置快照、请求头摘要、运行平台和版本号，后续维护者才能复现同一棵插件树。
