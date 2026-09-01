---
title: "小薇工具、Skill、文档与 Artifact 指南"
date: "2026-08-31"
description: "参考小薇工具审批、文件与附件、Web、Skill Markdown、Knowledge seam、文档解析和 Artifact 预览的输入输出与失败语义。"
tags: [小薇, 工具调用, Skills, Artifact]
draft: false
---

> **小薇技术篇 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · [04 插件架构](/posts/2026-08-31-xiaowei-04-plugin-architecture/) · [05 双 Host](/posts/2026-08-31-xiaowei-05-desktop-dual-host/) · [06 Agent 运行时](/posts/2026-08-31-xiaowei-06-agent-runtime-sessions/) · **07 工具与产物**

![小薇工具、审批与 Artifact 流水线](/images/2026-08-31-xiaowei-series/07-tools-skills-artifacts.png)

[打开可交互 HTML 图](/images/2026-08-31-xiaowei-series/07-tools-skills-artifacts.html)

我排查工具问题时，常见的第一反应是看模型有没有选对工具。实际故障往往发生得更早：审批没有回传、工具没有注入、附件在准入阶段被拒绝，或者远程 Host 不允许打开服务器路径。

这篇按一次调用的时间顺序复盘这些边界。代码里有 `tool/call`、guard、`artifact.read` 等硬事实；规格里标注 `approved` 的浏览器和账号搜索，则只代表批准进入开发或验收。

完整产品能力和规格状态集中在 [00 篇的产品能力地图](/posts/2026-08-31-xiaowei-00-overview/#产品能力地图)，本篇只展开工具、Skill 与 Artifact 的执行细节。

## 背景：工具调用不是一个函数调用

模型产生 tool-call 后，系统还要记录 call id，展示 pending card，检查参数和策略，询问一次性审批，进入沙箱，执行 body，归一化结果，再写回 Session。任何一步失败，都应该能告诉用户失败发生在哪一层。

如果每个工具自己处理这些步骤，审批顺序、错误格式和结果展示很快就会不一致。我需要一条统一流水线，也需要让文件、浏览器和 Artifact 保持各自的安全约束。

## 目标与非目标：把能力状态说准确

工具输入先写 `tool/call`，输出写 `tool/result`；Artifact 输入输出是内容寻址 id。附件准入通过不等于解析成功，Skill 可见不等于 Session 已加载，更不等于执行器存在。

审批、sandbox、Workspace 约束和 Host location 各自生效。`approved` 浏览器或账号搜索只表示规格批准；Knowledge seam 只有 Provider 也不能写成生产 RAG。

目标是让工具调用可记录、可拒绝、可恢复，让 HTML、文档和图片等产物有受控读取路径，让 Skill 安装和执行权限分开管理。

非目标是把“能看到接口”写成“用户已经可用”。`browser`、`account-web-search` 如果是 `approved`，正文只能说已批准或开发中；Skill 目录显示也不能证明当前 Session 已加载；知识库 Provider 存在也不能证明 RAG 已上线。

## 方案设计：从 call 到 result 的固定顺序

### 流水线调用链

`tool/call` → `tools/pre-execute` → approval/guard → `tools/execute` → tool body → `tools/post-execute` → `finalizeContent` → `tools/result` → `tool/result` → UI `presentResult`。

### 失败转换

拒绝时不执行 body；审批取消、无交互和拒绝统一成为拒绝结果。快照或 waterfall 抛错先归一化为可记录错误，再执行内容约束，不能让异常绕过 Session。

模型消息先产生 `tool/call` Session event，保存工具名、call id 和原样 arguments。随后经过 `tools/pre-execute` waterfall、单调 guard、`tools/execute` waterfall、工具 body、`tools/post-execute`，再执行定义的 `finalizeContent`，发送 `tools/result` 通知并追加 `tool/result`。

Pre-execute 放权限、hook 和 sandbox；`ctx.approval` 处理一次性询问；guard 只能拒绝或放行，不能重写已确认的执行身份；execute waterfall 适合超时和重试。监听 waterfall 的代码必须调用 `next()`，否则会提前截断链路。

## 详细设计：四个具体边界

### 案例一：Web 与文件系统必须分开

Web 搜索区分云端账号搜索和本机 SearXNG，来源由设置选择，本机请求不带 Bearer 或 Cookie。filesystem 工具按 Workspace 约束读写，和附件入口不是同一个路径。

### 案例二：附件准入不等于文件读取

|阶段|输入|失败示例|
|---|---|---|
|附件准入|文件声明与批次|`Document batch exceeds...`|
|分段传输|file-token 与 chunk|offset 冲突|
|解析|PDF/Office 单元|cursor、解析上限|
|Artifact|会话归属与字节|not found / owner mismatch|

本机文档的默认限制必须按传输方式区分。传统批次对每个 PDF、DOCX、XLSX 或 PPTX 使用 32 MiB 上限；本机可恢复 PDF 上传允许到 256 MiB，单个 chunk 默认不超过 4 MiB，暂存总量默认不超过 256 MiB。PDF commit 后可以按不超过 4 MiB 的窗口随机读取；DOCX、XLSX 和 PPTX 仍需完整物化，所以继续受 32 MiB 完整文件上限约束。

这些数字只能说明准入和读取预算。256 MiB 的 PDF 上传成功，不代表全部页面已经解析，更不代表模型已经读完内容；调用方仍要持续使用 `nextCursor`，直到没有游标，再合并各段结果。老式 DOC、XLS、PPT 不在现代 Office Open XML 支持范围内，扫描 PDF 也需要单独 OCR 能力。

### 案例三：HTML 预览不能打开远程路径

远程 HTML 不能调用 `host.openPath`。我复盘过 `path open failed: forbidden`：远程 Host 的本地路径不是用户电脑路径，放宽权限会暴露服务器文件。正确路径是 `html_build` 将自包含 HTML 写入 Artifact Registry，桌面再调用 `artifact.read`，校验 id、媒体类型、字节数和 base64 后交给预览器。

`tool-html` 曾出现 `cannot get property "tools" without inject`。插件使用 `ctx.tools` 却没有声明 `inject: ['tools']`，实际组合才暴露问题。修复时要同时核对插件的 `inject`、manifest 和 preset，不要只补一个测试 mock。

### 案例四：Skill 文本不是执行器

Skill Markdown 不等于执行器。账户 Skill 安装接收名称、描述和 Markdown instructions，写入私有 `SKILL.md`；真正可执行的工具仍由工具插件注册 schema、权限、审批、校验和 telemetry。看到 Skill 文本，不代表它可以运行任意脚本或依赖。

### Knowledge seam 仍需单独验收

Knowledge Definition、Provider 和检索 Consumer 只能说明接口已经接入。没有 implemented 规格、租户隔离、索引任务和真实数据验收，就只能称为知识能力开发中；浏览器和账号搜索若标为 approved，也只能按批准范围记录，不能写成已上线。

## QA 与上线验收：先测拒绝路径

选择本地 PDF，执行 begin、chunk、commit，确认附件引用进入 Session；调用 `document_read`，持续读取直到没有 `nextCursor`；将分析结果写入 Artifact；调用 `artifact.read`，校验 id、MIME、字节数和预览器输出。

覆盖审批四种结果、FS 越界、远程 `host.openPath` 403、HTML Artifact 预览、Skill 冲突、附件批次超限、单文件解析上限、浏览器撤销和搜索认证。每项记录规格状态。

先调用只读工具，检查 call/result 成对写入和 UI 卡片。然后覆盖批准一次、拒绝、取消、没有交互四种审批结果，确认拒绝时工具 body 没有运行。再测写文件，验证 Workspace 约束、先读后编辑和符号链接逃逸检查。

HTML 验收要检查远程 `host.openPath` 仍拒绝、Artifact 可按会话读取、预览器使用受限 CSP。文档验收要用小文件证明 `document_read` 到达模型，再用大文件证明切片和 cursor 合并，同时确认单文件解析上限仍生效。

Skill 验收分成目录安装、冲突处理、Session 发现和实际调用四项。浏览器、账号搜索的验收报告单列规格状态、认证条件和未完成项，不把 approved 当作生产上线。

## 踩坑：四个错误结论

`host.openPath` 403 说明远程服务器路径被保护，正确路径是 Artifact Registry → `artifact.read` → DocumentPreview。`tool-html` 使用 `ctx.tools` 却缺 `inject: ['tools']` 时，真实组合会报 `cannot get property "tools" without inject`。

|现象|优先检查|正确方向|
|---|---|---|
|HTML 打不开|Host location|保持 403，读取 Artifact|
|文档超限|attachment admission|区分切片传输与解析|
|Skill 能见不能用|Session preset 与工具|补加载或执行器|
|搜索无结果|账号认证与来源|按 approved 规格验收|

错误结论一是“按钮能点，所以路径能打开”。远程 HTML 的按钮只能证明 UI 收到了点击；真正结果要看 `artifact.read` 是否返回了正确资源。

错误结论二是“工具包已加载，所以工具可用”。`tool-html` 的 inject 遗漏告诉我，Provider、inject、manifest、preset 和请求 schema 任何一处缺失，都会在真实组合里失败。

错误结论三是“附件太大，所以本机文件读不了”。附件准入发生在模型请求前，filesystem tool 走另一条路径；两者要分别测量和报告。

错误结论四是“Skill 写了 Python，所以系统会执行 Python”。Markdown 是给模型的说明，执行能力必须有独立工具和策略；把说明文字直接当代码入口，会绕过审批和沙箱。

## 认知迭代：质量看拒绝和归属

本地文档仍有单文件解析、文件数、chunk、临时空间、归档和跨 Session token 限制。Skill Markdown 不执行脚本；浏览器和搜索的批准状态不改变发布状态。

每个工具至少补一条无权限、无交互、路径越界、资源不存在或内容超限用例，并保存 call/result、Host、Session 和 Artifact 归属证据。

## 参考：从调用到预览的排查流程

### 逐层定位

先查模型是否生成 `tool/call`，再查 inject、preset 和 approval；随后查 attachment 或工具 body 的实际入口；最后查 `tool/result` 与 `artifact.read`。不要用 UI 卡片代替这些事实。

记录版本、Profile、Host、Session、文件类型与大小、工具 schema、规格状态和错误原文。对 approved 项记录“已批准/开发中”，对 implemented 项附真实验收结果。

我现在不再用“工具调用成功”作为唯一指标，而是记录四个问题：调用有没有进 Session，拒绝发生在哪个 guard，结果属于哪个 Host 和 Session，用户点击预览时读取的是什么资源。

这套检查也改变了文章里的状态措辞。实现、批准、真实验收、公开发布是四个阶段。对于浏览器和搜索，我只引用规格状态；对于 Artifact 和文档，我把可读取路径、大小限制和错误信息写具体。

工具系统的下一步工作，是给每个新工具补一条失败用例：无权限、无交互、路径越界、资源不存在或内容超限。成功路径很容易演示，拒绝路径才告诉我边界有没有真正落到代码上。
