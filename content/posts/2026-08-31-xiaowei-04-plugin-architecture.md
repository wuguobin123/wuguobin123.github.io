---
title: "小薇技术复盘 04：我为什么没有重写 Agent 框架"
date: "2026-08-31"
description: "复盘小薇如何复用 DeepSeek Harness，用 Bundle、Profile 和 Preset 承接产品差异，以及两次装配故障带来的架构取舍。"
tags: [小薇, Harness, Cordis, 插件架构]
draft: false
---

> **小薇技术篇 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · **04 插件架构** · [05 双 Host](/posts/2026-08-31-xiaowei-05-desktop-dual-host/) · [06 Agent 运行时](/posts/2026-08-31-xiaowei-06-agent-runtime-sessions/) · [07 工具与产物](/posts/2026-08-31-xiaowei-07-tools-skills-artifacts/)

![小薇的插件、Profile 与能力分层](/images/2026-08-31-xiaowei-series/04-plugin-profile-seam.png)

[打开可交互 HTML 图](/images/2026-08-31-xiaowei-series/04-plugin-profile-seam.html)

上图先回答装配问题：Bundle 把能力带进产品，Profile 决定启动哪些插件，Preset 再决定当前 Agent 真正拿到哪些工具。三层没有谁可以替代谁。

我做小薇架构复盘时，首先要回答的是要不要重新造一套 Agent 框架，而非某个 API 怎么写。仓库里已经有模型适配、会话、工具和循环，桌面端又有本机 Host。重新实现会同时复制状态、审批和恢复逻辑，出问题时很难判断是产品代码还是基础设施代码。

我的选择是复用 DeepSeek Harness 的 Cordis 插件树，把小薇的差异放进 Bundle、Profile、Preset 和 Provider。这个决定少写了不少代码，也把问题从“框架怎么造”变成了“小薇应该怎样装进去”。

## 我为什么没有重写一套 Agent 框架

早期 Agent 可以把模型请求、工具函数和消息列表写在同一个服务里。需求增加后，几个变化会互相牵连：本地文件要换成远程沙箱，工具要加审批，模型要换 Provider，Session 要支持恢复，桌面还要把云端和本机结果放在一起。

如果每项变化都改主循环，测试会变成一条巨大的回归链。更麻烦的是，某个工具的安全规则可能被另一个工具复制一份，最后两份规则在拒绝条件上不一致。

我需要的是明确的装配位置。Cordis 的共享 `ctx`、服务依赖和可撤销 effect 让插件能够替换和卸载；每个 effect 都要有 disposer。

Profile 负责启动时挂载什么，Session 的 owner、资源路由和审批负责谁能使用什么。把两件事混在一起，会让安装状态被误当成授权状态。

## 我最后选择了 Bundle、Profile 和 Preset

启动从空条目列表开始，叠加 Profile bundles，再应用 Profile patch、home patch 和命令行 overlay。后层按 id 替换完整 config 或插入新条目，不能假定 YAML 文件顺序就是服务启动顺序。

我定位配置时先运行 `dsh --profile web --dump-config`，记录实际条目 id 和包名，再回到 patch 查来源。若只看源文件，容易漏掉 home patch 或命令行 overlay。

Bundle 是 Cordis 配置和挂载代码的分发格式。小薇 bundle 的 `cordis.patch.yml` 里能看到模型、账号服务、Artifact、Skill、Subagent、Workflow 和工具相关条目。Profile 叠加 bundle 后，Preset 再选择一次 Agent 实际拥有的服务、提示词和工具 schema。一个插件被装进树里，不代表它会进入当前 Session 的请求头；需要隔离的服务挂进独立 realm。

## 一项能力为什么要拆成三层

### 全局边界怎么读

![小薇全局技术架构：桌面、Host、Agent 与存储边界](/images/2026-08-31-xiaowei-series/04-global-architecture.png)

[打开全局架构可交互 HTML 图](/images/2026-08-31-xiaowei-series/04-global-architecture.html)

全局图可以从左往右读：用户先经过 Electron 的安全桥接，再由 Router 选择本机或云端 Host。两个 Host 各自保存 Session、Skill 和 Artifact，只有模型请求通过受控中继使用账号能力。

全局图把 Renderer、Preload、Main 和 `DualHostRouter` 放在桌面侧。Renderer 只持有页面状态和类型化桥接，Preload 只转发白名单方法，Main 负责 RPC、下行流和账号凭证。Router 同时维护 cloud 与 local 两个客户端，不能把它理解成一个全局环境开关。

Router 下面的本机 Host 负责源目录、进程、本地 Session、附件、Artifact、设置和已安装 Skill；云 Host 负责账号身份、钱包、模型凭证、云 Session、账号插件和云端副本。两边共享 RPC 定义与 Agent Loop，但不共享这些存储。

Agent Loop 从 Host 取得 Session、请求头和注册表。注册表保存工具、提示词和能力 Provider；账号推理只负责把已授权的模型请求送到配置的模型服务，不把本机文件或凭证搬进另一侧。浏览器和账号搜索没有放进这条主链路，因为它们还不是小薇当前任务执行的必经环节。

如果要沿一次真实任务继续往下读，00 篇的端到端流程图解释“先发生什么”，05 篇的双 Host 时序图解释“谁在什么时候调用谁”。本图只回答组件、所有权和信任边界，不在同一张图里重复时间顺序。

### Definition 与 Provider

Definition 拥有接口、参数和事件语义；Provider 拥有执行位置、资源和失败转换。Provider 替换时，调用者只依赖服务接口，不复制远程分支。

### Consumer 与请求头

Consumer 注册模型工具和展示方法，工具 schema 只有在当前 Preset 选中且服务可用时才进入 `request/header`。安装条目存在但未进入请求头，不算当前能力。

我把一项能力拆成三种角色。Service Definition 声明接口和事件；Service Provider 实现本机或云端版本；Consumer 使用服务，面向模型时通常还会注册工具。这样做不是为了概念完整，而是为了替换执行位置时不用重写调用者。

以 shell 为例，Consumer 只提交执行请求，Provider 可以通过本机 subprocess，也可以指向受限沙箱。工具的审批、超时和结果记录由统一事件处理。替换 Provider 时，Bash、PTY、文件系统与 LSP 可以继续共享执行世界，避免每个工具都写远程分支。

账号隔离还会影响插件选择。认证 principal 负责插件工厂修改；持久 Session 的 `ownerId` 决定 Skill 查询和会话写入。创建 Session 时记录可选插件选择，之后安装变化只作用于新 Session，恢复和 fork 继续采用历史选择。这是保证旧日志含义稳定的必要记录。

这里有一条实际检查路径：先找 patch 中的 id，再找 `name` 对应包；接着看包的 `inject`，确认服务 Provider 已挂载；最后检查 Preset 是否把工具 schema 加入请求头。任何一步缺失，都是“配置存在但能力不可用”。

## 我怎样确认这棵插件树真的工作

我先做配置树检查，确认 `dsh --dump-config` 中条目 id、依赖和 patch 顺序符合预期。再跑包级类型检查和单元测试，检查 disposer、事件 payload 与错误配置能否尽早失败。

产品验收要走真实组合：创建 Session，确认请求头包含预期工具 schema；执行一次允许调用和一次拒绝调用；重启后从 Session 日志恢复；再替换一个 Provider，检查 Consumer 行为不变。桌面端还要分别验证本机与云端资源 id 的归属。

## 两次故障改变了我的判断

### 注入缺失

插件实际读取 `ctx.tools` 却遗漏 `inject`，组合测试会出现 `cannot get property ... without inject`。修复要同时检查注入列表、manifest 和 preset，不能只给 mock 补字段。

### 隐式 fallback

未知服务或方法若静默换 Provider，Session 记录的权限和执行位置就无法解释。小薇组合要求缺失依赖直接失败，调用方再决定是否重试。

最容易误判的是“设置页看到了 Skill，所以模型一定能用”。实际上，Skill 目录清单、当前 Session 的 Preset、模型请求头中的 schema 是三个不同检查点。只证明第一项，会把 UI 投影当成运行时事实。

另一个坑是只检查 bundle 中有没有条目，却没有检查 Profile 顺序和 Preset 选择。同一个包可能已安装，却没有进入当前 Agent 请求头。

还有一种诱惑是为兼容旧组合保留隐藏 fallback。小薇仍在基础建设期，未知方法和缺失 Provider 应尽早报错；静默切换到另一个能力会让 Session、权限和审计都难以解释。

## 现在我会怎样做同类改动

新增能力先写 Definition，再列 Provider 的执行地点和 Consumer 的模型输入；把可调参数放进 config，把安全不变量留在代码；所有注册返回 disposer。

我提交前会保存 `dump-config`、请求头和一次恢复日志，确认没有改动其他 Profile。三份证据都能指向同一个包和版本，才认为装配可交接。

后来再加能力，我会按固定顺序查一遍：

1. 选择 Profile，执行 `dsh --profile <实际名称> --dump-config`。
2. 找到目标 bundle 的 id、`name` 与 `inject`，确认 Provider 已挂载。
3. 选择 Preset，创建 Session，检查 `request/header` 的工具 schema。
4. 调用工具，观察 `tool/call`、策略事件和 `tool/result`。
5. 重启并恢复 Session；若替换 Provider，重复同一调用并比较结果语义。

这套顺序看起来比“先跑起来再说”慢一点，实际却省下了大量猜测。最终 dump 回答装了什么，Preset 回答当前 Agent 选了什么，请求头回答模型看见了什么，`tool/call` 才回答它有没有真正使用。以前我总想找一个总开关证明能力可用，现在更愿意接受：装配系统里没有这种捷径。
