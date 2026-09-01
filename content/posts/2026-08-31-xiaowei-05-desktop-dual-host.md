---
title: "小薇桌面双 Host 参考：Electron、路由与恢复"
date: "2026-08-31"
description: "参考小薇桌面端的 Electron 三层、IPC、DualHostRouter 分类、资源 ID、双流重连与账号切换生命周期。"
tags: [小薇, Electron, DualHostRouter, 安全]
draft: false
---

> **小薇技术篇 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · [04 插件架构](/posts/2026-08-31-xiaowei-04-plugin-architecture/) · **05 双 Host** · [06 Agent 运行时](/posts/2026-08-31-xiaowei-06-agent-runtime-sessions/) · [07 工具与产物](/posts/2026-08-31-xiaowei-07-tools-skills-artifacts/)

![Electron 与本机、云端双 Host](/images/2026-08-31-xiaowei-series/05-desktop-dual-host.png)

[打开可交互 HTML 图](/images/2026-08-31-xiaowei-series/05-desktop-dual-host.html)

我复盘桌面客户端时，最危险的错误来自把两个 Host 当成一个服务，远比按钮样式问题严重。这样一来，列表看起来正常，打开、审批、Session 事件却可能发到错误的位置。

小薇的桌面端因此先固定 Electron 三层，再把本机 Host 和云端 Host 的调用策略写进 `DualHostRouter`。以下只描述仓库代码和规格已有的设计，不把一次安装包测试扩大成所有能力已上线。

> **事实状态**：桌面 README 明确了 main/preload/renderer 隔离；`DualHostRouter` 代码明确了 RPC 分类、资源 id 编码和 fail-closed 行为。云端搜索、浏览器等能力仍以规格状态为准。

## 背景：桌面端同时面对两个执行地点

### 读者与前置知识

本文面向维护 Electron 客户端、RPC 和本机运行时的工程师。需要知道进程、IPC、SSE/WebSocket 和 Promise 生命周期；不要求熟悉全部前端组件。

### 术语与对象

|对象|职责|证据|
|---|---|---|
|Renderer|页面与交互|React、HashRouter|
|Preload|窄桥|`contextBridge`|
|Main|RPC、连接、凭证|`ipc-handlers.ts`|
|Host|实际执行环境|本机或云端|

本机 Workspace 需要直接读写用户选定的原目录，云端 Workspace 则通过 `workspace.importDirectory` 创建账号私有副本。本机修改不会自动同步到云端，两个 Session 的事件流和 Artifact 也不能互相读取。

与此同时，账号登录、钱包和模型密钥属于云端；本机 Host 需要保存本机 Session、设置、附件和 Skill。UI 希望把它们列在一个侧边栏，路由却必须保持分离。

## 目标与非目标：先确定隔离线

### 输入与输出

Router 输入方法名和 payload，输出来自唯一归属 Host 的结果；聚合列表只合并展示项并附加 location。响应 rpcId 和事件帧必须保持同一位置编码。

### 非目标与权限

远程 Host 不获得打开服务器路径的桌面权限，Renderer 不获得任意网络或 Node 权限；未知方法不猜 Host，缺少本机运行时也不能静默改走云端。

目标是让 Renderer 只访问类型化桥接，让 Main 统一持有 RPC、SSE 和凭证，让每个资源请求回到创建它的 Host。列表可以聚合，但聚合不改变资源所有权。

非目标是让远程 Host 代替本机弹目录选择器，或把云端服务器路径暴露给桌面。`host.openPath` 只能在它拥有的执行位置工作；远程 HTML 曾出现 `path open failed: forbidden`，不应通过放宽权限解决。

## 方案设计：Electron 三层各自持权

### IPC 调用链

Renderer 调用 `window.workbenchApi.request(method, payload)`，Preload 转给 Main，Main 的 API client 发 POST 并将结果投影回 IPC。Renderer 不构造 RPC 信封。

### 下行与更新

Main 代理 mux 和 host 下行，协议 ping/pong 维持连接代次；更新下载也只能由 Main 校验路径后执行，页面只能发起有限的更新动作。

Renderer 是 React 页面，不能直接 `fetch`，也不拿到 `ipcRenderer`、`require` 或 `process`。Preload 只通过 `contextBridge` 暴露 `request`、`subscribeMux`、`subscribeHost`、`respond` 和有限的设置方法。

Main 负责 POST `/api/<method>`、SSE 下行、IPC 分发、更新下载和账号凭证。CSP、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 与阻止 `will-navigate`、新窗口，共同限制页面权限。

## 详细设计：Router 按方法和资源归属分流

### 分类表

|类别|示例|策略|
|---|---|---|
|aggregate|`workspace.list`|双 Host 并行合并|
|cloud|`account.signin`|固定云端|
|resource|`session.history`|按资源 id|
|explicit|`workspace.create`|payload 明确位置|

### 双流与资源 ID

`streamMux` 和 `streamHost` 各自取云端、本机迭代器并合并。Router 给 `sessionId`、`artifactId` 等 opaque id 加位置前缀，发回目标 Host 前剥离；未知方法直接失败。

`DualHostRouter` 把方法分为 aggregate、cloud、resource、explicit。`workspace.list`、`session.list`、`session.search` 会并行访问两边并为结果加位置标记；账号登录、钱包、模型密钥和账号插件固定走 cloud；Session、Artifact、审批等带资源 id 的请求按 id 路由；`workspace.create` 要求 payload 明确 location。

位置编码采用 opaque resource id。Router 对返回对象中的 `sessionId`、`workspaceId`、`artifactId`、`approvalId` 及对应数组加前缀；发回 Host 前再剥离。响应 `rpcId` 和事件帧也必须执行同一处理，否则会出现请求已完成但前端无法匹配响应的错误。

未知方法不会猜默认 Host，而是抛出“unclassified or requires an explicit Host location”。这是 fail-closed：宁可让调用失败，也不让数据和副作用静默换主。

## QA 与上线验收：端口监听不算 ready

### E2E 教程

启动本机 Host，等待 `workspace.list`；创建本机 Workspace，再创建云端 Workspace。打开两边 Session，分别读取历史和 Artifact，确认调用路径不交叉。随后断开一条下行链路，观察重连和重新拉取。

### 验收清单

检查三进程安全属性、IPC 方法白名单、ping/pong、两类列表聚合、位置 id、双 Host 失败、`workspace.list` ready 探针和切号后的旧 Host 停止。

在两个 Host 分别创建 Workspace 和 Session，确认聚合列表能显示位置；随后重命名、读取历史、创建 Artifact，检查每次调用仍回到原 Host。再让一边失败，验证另一边的聚合结果仍可用；两边都失败才报告整体失败。

连接测试不能只看端口。0.3.4 的问题是提交消息成功，但半开的 WebSocket 不再下发事件，界面一直等。修复后 Main 用 ping/pong 识别静默死连接，关闭旧代次，重建 mux 与 host，并重新拉取打开的 Session。只有 `workspace.list` 成功，本机 Host 才报告 ready。

当时桌面测试是 56 项，连接层测试是 14 项；安装后的 `/Applications/小薇.app` 先返回“已恢复”，静置 42 秒跨过一次心跳周期后，再次发送得到“连接正常”。这组结果只证明 0.3.4 的该条链路，但比“WebSocket 对象还在”更接近用户感受到的可用性。

## 踩坑：半开连接与错误的 fallback

### 失败语义

WebSocket 半开时 TCP 可能仍显示连接；缺 pong 或 inbound 帧超时就必须关闭该代次。云端或本机单边失败可以保留另一边结果，两边失败才返回聚合错误。

### 故障排查表

|现象|检查|结论|
|---|---|---|
|一直 loading|pong 与连接代次|半开连接，触发重连|
|本机数据跑云端|资源 id 与分类|Router 路由错误，禁止 fallback|
|远程打开失败|`host.openPath`|403 是预期边界，改走 Artifact|

最难复现的一类问题是 WebSocket 半开：TCP 看似还连着，应用事件已经不再到达。若只监听业务消息，健康 Workspace 会被错误标记断开；若只看连接对象存在，UI 又会一直等待。ping/pong 的代次和重连后的重新拉取必须同时测试。

另一个坑是用云端 fallback 修复本机失败。Router 的 resource 请求如果本机不可用，不能悄悄改走云端；这会把源目录操作、审批和 Session 写到错误账号。未知 RPC 同样不能默认 cloud。

远程 HTML 的 `host.openPath` 403 也给了明确答案：服务器本地路径不属于桌面用户。正确路径是由 `html_build` 产生 Artifact，再由 `artifact.read` 取回内容交给预览器，不能放宽远程 openPath。

## 认知迭代：路由表先于页面设计

### 限制

本机 Host 的文件和进程属于设备；云端账号、钱包和云端副本属于服务端。聚合列表不提供跨 Host 写操作，`host.openPath` 不能变成远程文件浏览器。

### 最佳实践结尾

维护 RPC ownership 表后再写页面；先验证 stop、切号和 ready，再优化重连动画。每个新方法必须声明分类、资源字段、响应剥离规则和失败语义。

## 参考：账号切换与半开恢复

### 生命周期

切号时取消旧请求，停止旧 Host，确认停止完成后再保存新凭证并广播认证状态。新 Host 只有 `workspace.list` 成功才算 ready；仅端口监听不足以证明插件和历史已初始化。

### 排查顺序

1. 查看当前 base URL、用户 id 和运行时 key。
2. 检查旧 mux/host 是否已 stop，是否仍有 pending request。
3. 分别检查云端、本机 `workspace.list`。
4. 检查资源 id 是否带正确位置，再检查具体 RPC。

### 当前路由与旧实现的区别

当前产品使用 `DualHostRouter` 同时维护 cloud 和 local 两个客户端，`getEnvironment()` 保留兼容返回值不代表系统仍有一个全局环境选择器。旧的 `ConnectionRouter` 全局切换模型会在切换时替换唯一连接；它不能用来解释当前列表聚合、资源 ID 和双流行为。

### `documentUpload` 特例

`session.documentUpload.begin/chunk/commit/abort` 在当前分类中强制选择本机。原因是桌面本地文档需要从用户设备分段读取，上传 token 只在本机 Session 范围内有效。其他带资源的 Session 方法仍按资源 ID 找 Host；不要把所有 session 方法都概括成本机或云端。

### 两边失败的返回规则

聚合方法用 `Promise.allSettled` 并行调用。单边拒绝时，成功一边仍返回并标记 location；两边都拒绝才抛 `AggregateError`。`host.describe` 取可用结果，`workspace.list`、`session.list`、`session.search` 分别合并列表和 hasMore。调用方应把部分成功显示为部分数据，而不是伪造另一边为空。

### 实际检查命令

桌面端测试应检查 `rpcHostPolicy()` 对所有 `RpcMethodMap` 方法穷尽分类；unknown method 必须得到 undefined 并在 call 时失败。集成探针按顺序记录：凭证 owner、runtime home、Host 启动、双流订阅、`workspace.list` ready。任何一个步骤未完成，都不能报告“本机已就绪”。

切换环境 API 仍可能被旧调用方调用，但当前实现的 `setEnvironment()` 是兼容空操作；它不会关闭 cloud、也不会让 local 变成唯一目标。维护者应迁移调用方到资源位置和显式 location，不能通过这个兼容方法恢复旧的全局选择语义。

切号日志把“停止旧连接”“写入新凭证”“启动新本机 Host”“ready 探针”分成四个时间点。若新凭证已经广播而旧流仍在发事件，问题在生命周期顺序；若新 Host 已监听但 `workspace.list` 失败，问题在插件装配或运行时路径。两类错误不能用同一个“连接失败”提示覆盖。

聚合列表的验收也要保存原始来源。前端显示一个列表并不代表两个 Host 返回了同样的数据；调试时应记录每个 item 的 location、原始 id 和后续请求方法。这样遇到“列表有、打开无”时，可以直接判断是资源编码、路由分类还是目标 Host 自身错误。

安全检查还要覆盖导航和目录选择器。远程连接时，`host.pickDirectory` 这类依赖 Host 显示器的能力不能被硬接到无桌面会话的服务端；本机选择器只服务 loopback Host。将两种能力混装，会把一个明确的权限错误变成看似随机的 UI 故障。

我现在会在写 UI 之前列出 RPC ownership 表：方法属于 cloud、local、resource 还是 explicit；返回值哪些字段带资源 id；响应如何剥离；连接失效后谁重新加载。这个表比“两个环境切换按钮”更接近真实系统。

双 Host 的难点不在同时启动两个进程，而在每个请求、结果、事件和生命周期都有明确归属。新增能力时，先补路由分类和 ready 探针，再接页面入口。验证时保存两端原始响应，确认位置标签来自 Router，而非页面临时拼接。异常时保留连接代次、最后 pong 时间和资源位置。
