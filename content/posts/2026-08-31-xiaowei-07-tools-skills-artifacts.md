---
title: "小薇技术复盘 07：四次故障教会我怎样设计工具"
date: "2026-08-31"
description: "从附件超限、远程 HTML、工具注入和 Skill 误解四次故障出发，复盘小薇怎样处理审批、文档、工具与可预览产物。"
tags: [小薇, 工具调用, Skills, Artifact]
draft: false
---

> **小薇技术篇 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · [04 插件架构](/posts/2026-08-31-xiaowei-04-plugin-architecture/) · [05 双 Host](/posts/2026-08-31-xiaowei-05-desktop-dual-host/) · [06 Agent 运行时](/posts/2026-08-31-xiaowei-06-agent-runtime-sessions/) · **07 工具与产物**

![小薇工具、审批与 Artifact 流水线](/images/2026-08-31-xiaowei-series/07-tools-skills-artifacts.png)

[打开可交互 HTML 图](/images/2026-08-31-xiaowei-series/07-tools-skills-artifacts.html)

这张图适合从左往右读：模型提出调用，审批与 Guard 决定能不能做，Execute 在所属 Host 执行，最后把结果写回 Session 或 Artifact。Skill 和文档提供说明与输入，但不会绕过中间的安全检查。

我排查工具问题时，最初总盯着模型：是不是工具选错了，参数是不是写坏了。后来连续遇到几次故障，才发现问题经常发生在模型之外：附件在入口就被拒绝，工具插件少了一项注入，远程 Host 没有资格打开路径，或者我们把一份 Skill 说明误当成了执行器。

完整产品能力和规格状态集中在 [00 篇的产品能力地图](/posts/2026-08-31-xiaowei-00-overview/#产品能力地图)，本篇只展开工具、Skill 与 Artifact 的执行细节。

## 工具不是一个函数，而是一段旅程

模型产生 tool-call 后，系统还要记录 call id，展示 pending card，检查参数和策略，询问一次性审批，进入沙箱，执行 body，归一化结果，再写回 Session。任何一步失败，都应该能告诉用户失败发生在哪一层。

如果每个工具自己处理这些步骤，审批顺序、错误格式和结果展示很快就会不一致。我需要一条统一流水线，也需要让文件、浏览器和 Artifact 保持各自的安全约束。

工具输入先写 `tool/call`，输出写 `tool/result`；Artifact 使用内容寻址 id。审批、sandbox、Workspace 约束和 Host location 各自生效。它们之所以分开，不是为了把架构画复杂，而是因为每一层都曾单独出过问题。

## 一次调用怎样经过策略和记录

### 流水线调用链

`tool/call` → `tools/pre-execute` → approval/guard → `tools/execute` → tool body → `tools/post-execute` → `finalizeContent` → `tools/result` → `tool/result` → UI `presentResult`。

### 失败转换

拒绝时不执行 body；审批取消、无交互和拒绝统一成为拒绝结果。快照或 waterfall 抛错先归一化为可记录错误，再执行内容约束，不能让异常绕过 Session。

模型消息先产生 `tool/call` Session event，保存工具名、call id 和原样 arguments。随后经过 `tools/pre-execute` waterfall、单调 guard、`tools/execute` waterfall、工具 body、`tools/post-execute`，再执行定义的 `finalizeContent`，发送 `tools/result` 通知并追加 `tool/result`。

Pre-execute 放权限、hook 和 sandbox；`ctx.approval` 处理一次性询问；guard 只能拒绝或放行，不能重写已确认的执行身份；execute waterfall 适合超时和重试。监听 waterfall 的代码必须调用 `next()`，否则会提前截断链路。

## 四个故障怎样改变实现

### 附件太大，不代表本机文件不能读

|阶段|输入|失败示例|
|---|---|---|
|附件准入|文件声明与批次|`Document batch exceeds...`|
|分段传输|file-token 与 chunk|offset 冲突|
|解析|PDF/Office 单元|cursor、解析上限|
|Artifact|会话归属与字节|not found / owner mismatch|

本机文档的默认限制必须按传输方式区分。传统批次对每个 PDF、DOCX、XLSX 或 PPTX 使用 32 MiB 上限；本机可恢复 PDF 上传允许到 256 MiB，单个 chunk 默认不超过 4 MiB，暂存总量默认不超过 256 MiB。PDF commit 后可以按不超过 4 MiB 的窗口随机读取；DOCX、XLSX 和 PPTX 仍需完整物化，所以继续受 32 MiB 完整文件上限约束。

这些数字只能说明准入和读取预算。256 MiB 的 PDF 上传成功，不代表全部页面已经解析，更不代表模型已经读完内容；调用方仍要持续使用 `nextCursor`，直到没有游标，再合并各段结果。老式 DOC、XLS、PPT 不在现代 Office Open XML 支持范围内，扫描 PDF 也需要单独 OCR 能力。

### HTML 做出来了，桌面端却打不开

远程 HTML 不能调用 `host.openPath`。我复盘过 `path open failed: forbidden`：远程 Host 的本地路径不是用户电脑路径，放宽权限会暴露服务器文件。正确路径是 `html_build` 将自包含 HTML 写入 Artifact Registry，桌面再调用 `artifact.read`，校验 id、媒体类型、字节数和 base64 后交给预览器。

### 工具写好了，却没有装进真实组合

`tool-html` 曾出现 `cannot get property "tools" without inject`。插件使用 `ctx.tools` 却没有声明 `inject: ['tools']`，实际组合才暴露问题。修复时要同时核对插件的 `inject`、manifest 和 preset，不要只补一个测试 mock。

### Skill 能看见，不代表它能执行

Skill Markdown 不等于执行器。账户 Skill 安装接收名称、描述和 Markdown instructions，写入私有 `SKILL.md`；真正可执行的工具仍由工具插件注册 schema、权限、审批、校验和 telemetry。看到 Skill 文本，不代表它可以运行任意脚本或依赖。

## 修复以后，我沿着一条真实任务再走一遍

选择本地 PDF，执行 begin、chunk、commit，确认附件引用进入 Session；调用 `document_read`，持续读取直到没有 `nextCursor`；将分析结果写入 Artifact；调用 `artifact.read`，校验 id、MIME、字节数和预览器输出。

先调用只读工具，检查 call/result 成对写入和 UI 卡片。然后覆盖批准一次、拒绝、取消、没有交互四种审批结果，确认拒绝时工具 body 没有运行。再测写文件，验证 Workspace 约束、先读后编辑和符号链接逃逸检查。

HTML 验收要检查远程 `host.openPath` 仍拒绝、Artifact 可按会话读取、预览器使用受限 CSP。文档验收要用小文件证明 `document_read` 到达模型，再用大文件证明切片和 cursor 合并，同时确认单文件解析上限仍生效。

Skill 则分成目录安装、冲突处理、Session 发现和实际调用四步。这里最容易偷懒的是只看设置页里有没有名字，但真正决定当前任务能不能用的，是 Session 有没有加载说明，以及相应工具有没有进入请求头。

## 仍然容易误判的地方

`host.openPath` 403 说明远程服务器路径被保护，正确路径是 Artifact Registry → `artifact.read` → DocumentPreview。`tool-html` 使用 `ctx.tools` 却缺 `inject: ['tools']` 时，真实组合会报 `cannot get property "tools" without inject`。

|现象|优先检查|正确方向|
|---|---|---|
|HTML 打不开|Host location|保持 403，读取 Artifact|
|文档超限|attachment admission|区分切片传输与解析|
|Skill 能见不能用|Session preset 与工具|补加载或执行器|

错误结论一是“按钮能点，所以路径能打开”。远程 HTML 的按钮只能证明 UI 收到了点击；真正结果要看 `artifact.read` 是否返回了正确资源。

错误结论二是“工具包已加载，所以工具可用”。`tool-html` 的 inject 遗漏告诉我，Provider、inject、manifest、preset 和请求 schema 任何一处缺失，都会在真实组合里失败。

错误结论三是“附件太大，所以本机文件读不了”。附件准入发生在模型请求前，filesystem tool 走另一条路径；两者要分别测量和报告。

错误结论四是“Skill 写了 Python，所以系统会执行 Python”。Markdown 是给模型的说明，执行能力必须有独立工具和策略；把说明文字直接当代码入口，会绕过审批和沙箱。

## 现在我先问：故障到底发生在哪一层

现在遇到“工具不能用”，我会先查模型有没有生成 `tool/call`，再查 inject、Preset 和 approval；随后看请求走的是附件入口还是工具 body；最后确认 `tool/result` 与 `artifact.read`。页面卡片只是这条链路的投影，不是答案。

每个工具至少要有一条失败用例：无权限、无交互、路径越界、资源不存在或内容超限。现场记录版本、Profile、Host、Session、文件类型与大小、工具 schema 和错误原文。这样下一次看到“打不开”时，我们讨论的会是同一个故障，而不是四个人心里的四种猜测。

四次故障之后，我对工具的理解发生了变化。工具能力不等于“模型会调用一个函数”，而是这次调用能否被允许、能否在正确的位置执行、失败后能否说清原因、结果能否留给用户。做到这四件事，工具才真正进入产品。
