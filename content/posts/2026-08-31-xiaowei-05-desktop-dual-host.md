---
title: "小薇技术复盘 05：桌面端为什么需要两个 Host"
date: "2026-08-31"
description: "从一次半开连接故障出发，复盘小薇为什么同时保留本机与云端 Host，以及资源路由、重连和切号怎样避免串数据。"
tags: [小薇, Electron, DualHostRouter, 安全]
draft: false
---

> **小薇技术篇 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · [04 插件架构](/posts/2026-08-31-xiaowei-04-plugin-architecture/) · **05 双 Host** · [06 Agent 运行时](/posts/2026-08-31-xiaowei-06-agent-runtime-sessions/) · [07 工具与产物](/posts/2026-08-31-xiaowei-07-tools-skills-artifacts/)

![Electron 与本机、云端双 Host](/images/2026-08-31-xiaowei-series/05-desktop-dual-host.png)

[打开可交互 HTML 图](/images/2026-08-31-xiaowei-series/05-desktop-dual-host.html)

架构图中间的 Router 不是数据中转站，而是归属判断器。列表可以来自两个 Host，但文件、Session 和 Artifact 始终回到创建它们的位置。

我复盘桌面客户端时，最危险的错误来自把两个 Host 当成一个服务，远比按钮样式问题严重。这样一来，列表看起来正常，打开、审批、Session 事件却可能发到错误的位置。

小薇的桌面端因此先固定 Electron 三层，再把本机 Host 和云端 Host 的调用策略写进 `DualHostRouter`。这个方案不算轻，但每个请求去了哪里，终于可以被解释清楚。

## 一个全局环境开关为什么不够

本机 Workspace 需要直接读写用户选定的原目录，云端 Workspace 则通过 `workspace.importDirectory` 创建账号私有副本。本机修改不会自动同步到云端，两个 Session 的事件流和 Artifact 也不能互相读取。

与此同时，账号登录、钱包和模型密钥属于云端；本机 Host 需要保存本机 Session、设置、附件和 Skill。UI 希望把它们列在一个侧边栏，路由却必须保持分离。

Router 输入方法名和 payload，输出来自唯一归属 Host 的结果；聚合列表只合并展示项并附加 location。响应 rpcId 和事件帧必须保持同一位置编码。

远程 Host 不获得打开服务器路径的桌面权限，Renderer 不获得任意网络或 Node 权限；未知方法不猜 Host，缺少本机运行时也不能静默改走云端。

Renderer 只访问类型化桥接，Main 统一持有 RPC、SSE 和凭证，每个资源请求回到创建它的 Host。列表可以放在一起展示，但聚合不改变资源所有权。远程 Host 也不会代替本机弹目录选择器，更不能把云端服务器路径暴露给桌面。`host.openPath` 在远程 HTML 上返回过 `path open failed: forbidden`，这个 403 应该保留，预览要改走 Artifact。

## 从 Electron 三层走到双 Host

### IPC 调用链

Renderer 调用 `window.workbenchApi.request(method, payload)`，Preload 转给 Main，Main 的 API client 发 POST 并将结果投影回 IPC。Renderer 不构造 RPC 信封。

Main 代理 mux 和 host 下行，协议 ping/pong 维持连接代次；更新下载也只能由 Main 校验路径后执行，页面只能发起有限的更新动作。

Renderer 是 React 页面，不能直接 `fetch`，也不拿到 `ipcRenderer`、`require` 或 `process`。Preload 只通过 `contextBridge` 暴露 `request`、`subscribeMux`、`subscribeHost`、`respond` 和有限的设置方法。

Main 负责 POST `/api/<method>`、SSE 下行、IPC 分发、更新下载和账号凭证。CSP、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 与阻止 `will-navigate`、新窗口，共同限制页面权限。

## 一次半开连接暴露了路由问题

0.3.4 出现过这样的现象：消息已经提交，WebSocket 看起来也连着，后续事件却不再回来。页面只能一直等，重新打开 Session 后才看到结果。这个故障让我意识到，“请求发出”和“事件还能回来”是两件事，双 Host 又把问题放大了一倍。

![小薇双 Host 关键时序：启动、推理、重连与切号](/images/2026-08-31-xiaowei-series/05-dual-host-sequence.png)

[打开双 Host 关键时序可交互 HTML 图](/images/2026-08-31-xiaowei-series/05-dual-host-sequence.html)

时序图分成冷启动、任务执行、结果回传、半开恢复和账号切换五段。看故障时重点比较第四、第五段：重连是替换连接代次，切号还要先停止旧账号运行时，两者不能共用一个“重新连接”动作。

### 冷启动到 ready

冷启动时 Main 启动本机 Host，建立 cloud 与 local 的下行订阅，然后等待 `workspace.list` 成功。端口监听只说明进程占用了端口，不能说明插件、Session 和 Workspace 已准备好。ready 探针通过后，Renderer 才刷新两边聚合列表。

### 资源调用与账号推理

Renderer 的请求经 Preload、Main 到 `DualHostRouter`。Router 对 `aggregate` 并行访问两边，对 `cloud` 固定走云端，对 `resource` 按资源 ID 选择 Host，对 `explicit` 要求 payload 带 location。`session.documentUpload.begin/chunk/commit/abort` 特殊地固定本机，避免本地文件 token 被送到云端。

资源 ID 返回前加上 Host 位置，响应发回前剥离；账号推理请求可以由本机 Agent 使用已授权的云端模型服务，但 Session、工具结果、审批和 Artifact 仍留在产生它们的 Host。

### 半开重连与切号

丢失 pong 或入站帧超时后，Main 必须关闭旧连接代次，重开 mux/host 双流并重新拉取打开的 Session。切号顺序固定为 cancel 请求、stop 旧 Host、保存新 credential、创建新的 `DSH_HOME`，最后等待新的 `workspace.list` ready。顺序不能颠倒，否则新账号页面可能继续接收旧账号事件。

`streamMux` 和 `streamHost` 各自取云端、本机迭代器并合并。Router 给 `sessionId`、`artifactId` 等 opaque id 加位置前缀，发回目标 Host 前剥离；未知方法直接失败。

`DualHostRouter` 把方法分为 aggregate、cloud、resource、explicit。`workspace.list`、`session.list`、`session.search` 会并行访问两边并为结果加位置标记；账号登录、钱包、模型密钥和账号插件固定走 cloud；Session、Artifact、审批等带资源 id 的请求按 id 路由；`workspace.create` 要求 payload 明确 location。

位置编码采用 opaque resource id。Router 对返回对象中的 `sessionId`、`workspaceId`、`artifactId`、`approvalId` 及对应数组加前缀；发回 Host 前再剥离。响应 `rpcId` 和事件帧也必须执行同一处理，否则会出现请求已完成但前端无法匹配响应的错误。

未知方法不会猜默认 Host，而是抛出“unclassified or requires an explicit Host location”。这是 fail-closed：宁可让调用失败，也不让数据和副作用静默换主。

## 修复后，我在安装包里等了 42 秒

启动本机 Host，等待 `workspace.list`；创建本机 Workspace，再创建云端 Workspace。打开两边 Session，分别读取历史和 Artifact，确认调用路径不交叉。随后断开一条下行链路，观察重连和重新拉取。

检查不再只看端口。我会看三进程安全属性、IPC 白名单、ping/pong、列表聚合、位置 id、双 Host 单边失败、`workspace.list` 探针和切号后的旧 Host 是否停止。修复后的 `/Applications/小薇.app` 静置 42 秒，跨过一次心跳周期后仍能再次发送。这不是一句“连接稳定”的结论，但至少复现并穿过了原来的故障窗口。

## 半开连接留下的教训

WebSocket 半开时 TCP 可能仍显示连接；缺 pong 或 inbound 帧超时就必须关闭该代次。云端或本机单边失败可以保留另一边结果，两边失败才返回聚合错误。

|现象|检查|结论|
|---|---|---|
|一直 loading|pong 与连接代次|半开连接，触发重连|
|本机数据跑云端|资源 id 与分类|Router 路由错误，禁止 fallback|
|远程打开失败|`host.openPath`|403 是预期边界，改走 Artifact|

## 我最后保留的设计代价

本机 Host 的文件和进程属于设备；云端账号、钱包和云端副本属于服务端。聚合列表不提供跨 Host 写操作，`host.openPath` 不能变成远程文件浏览器。

维护 RPC ownership 表后再写页面；先验证 stop、切号和 ready，再优化重连动画。每个新方法必须声明分类、资源字段、响应剥离规则和失败语义。

切号时取消旧请求，停止旧 Host，确认停止完成后再保存新凭证并广播认证状态。新 Host 只有 `workspace.list` 成功才算 ready；仅端口监听不足以证明插件和历史已初始化。

我最后接受的代价，是为每个新 RPC 方法声明归属，并把“停止旧连接、写入新凭证、启动新本机 Host、等待 ready”分成四个时间点。代码和测试都变多了，但串账号、错 Host 和半开连接不再挤成一个模糊的“网络异常”。这是双 Host 真正带来的价值。
