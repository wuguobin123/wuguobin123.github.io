---
title: "小薇产品总览与快速开始指南"
date: "2026-08-31"
description: "面向首次使用者说明小薇的账号、双 Host、Workspace、Session 和产物，并给出登录、读写、审批、重启恢复与结果判定流程。"
tags: [小薇, AI智能体, DeepSeek Harness, 产品化]
---

> **小薇平台分析 · 系列目录**
>
> **00 快速开始** · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · [02 数据与工作区](/posts/2026-08-31-xiaowei-02-product-workspaces-data/) · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · [04 插件架构](/posts/2026-08-31-xiaowei-04-plugin-architecture/) · [05 双 Host](/posts/2026-08-31-xiaowei-05-desktop-dual-host/) · [06 Agent 运行时](/posts/2026-08-31-xiaowei-06-agent-runtime-sessions/) · [07 工具与产物](/posts/2026-08-31-xiaowei-07-tools-skills-artifacts/)

本篇总览以 Workbuddy 的执行思路为起点：让 Agent 处理文件、调用工具、保留会话，再把结果交给人。迁移到小薇以后，重点落在账号归属、桌面安装、云端发布和失败恢复。

小薇使用 DeepSeek Harness 开源底座，不从零重写底层框架，而是在它的插件、模型适配器、工具注册表、事件和 Session 之上做产品化、集成与交付。下面的判断以仓库文档、规格状态和验收记录为依据。

![小薇从输入到可交付结果的产品结构](/images/2026-08-31-xiaowei-series/00-overview.png)

[查看这张图的自包含 HTML](/images/2026-08-31-xiaowei-series/00-overview.html)

## 背景：Workbuddy 的执行思路怎样落到小薇

### 开始前准备

本文面向首次使用者、桌面端开发者和发布验收人员。准备一个已认证账号、一台能运行 Electron 的设备，以及一个不含敏感资料的测试目录。源码命令在仓库根目录运行。

Workbuddy 的执行经验说明，对话只是入口，实际工作发生在工具和文件里。一次任务会读资料、修改源目录、生成产物，也可能等待批准。小薇将执行位置分为桌面本机 Host 和云端 Host。

桌面客户端使用 Electron。main 进程负责 RPC、SSE 和 IPC，renderer 只使用类型化桥接。这样迁移时，界面可以保持简单，账号、Host 连接和安全规则放在进程边界之外。

## 目标与非目标：先把产品边界写清楚

目标用户是需要处理文件、调用工具并保留历史的个人或团队。一次任务可以接收文字、目录文件或有界附件，最后交付消息、工具结果、事件和可打开的产物。账号 principal、资源所在 Host、Session owner、Workspace 策略和审批共同决定权限；断线、审批拒绝和工具报错也必须保留原始状态，不能只显示一句“执行失败”。

这不是一套离线模型，也不会把所有工具塞进桌面包。本机推理仍经认证账号的模型路由并消耗钱包余额，云端 Workspace 也不会自动同步本机目录。

## 方案设计：用 bundle 和 Host 组织迁移

### 组件职责

`packages/bundle/xiaowei` 负责账号和云端能力，`packages/bundle/xiaowei-local` 负责本机安全 preset。`apps/desktop` 的 main 进程负责 RPC、SSE 和 IPC，renderer 只使用类型化桥接。

### 配置与状态表

| 对象 | 初始状态 | 归属 |
| --- | --- | --- |
| 本机 Host | 认证后启动账号专属运行时 | 设备与账号运行时 |
| 云端 Host | 认证后保持连接 | 账号 |
| Workspace | 创建时显式指定本机或云端 | 资源 ID 中的位置 |
| Session | 创建后记录事件 | 创建它的 Workspace 所在 Host |

### 产品能力地图

下表按使用入口、数据位置和交付物整理当前能力。状态只引用仓库规格、bundle 的 `tool-capabilities` 清单或验收记录；`approved` 代表方案已批准，不能直接当作已上线能力。

| 能力域 | 用户入口 | 本机或云端归属 | 权限与审批 | 交付物 | 状态和限制 |
| --- | --- | --- | --- | --- | --- |
| 账号与商业 | 注册、邮箱验证、邀请、登录、钱包和模型设置 | 账号、模型与钱包在云端 | 账号认证；模型调用受账号额度约束 | principal、账户状态、模型请求 | 认证与邀请注册为 `implemented`；商业规则以云端实现为准 |
| Workspace / Session | Workspace 创建、列表、搜索、Session 历史与恢复 | Workspace 可在本机或云端；Session 跟随 Workspace | 资源 owner、位置和 Session 权限 | 目录引用、事件日志、历史消息 | 账号隔离和导航交互为 `implemented`；本机环境总规格仍为 `approved` |
| Agent 执行 | 对话、Plan、Todo、Goal、Job、Workflow、Subagent 与上下文压缩 | 执行由对应 Host 的 preset 提供 | 工具调用、写入和外部副作用按权限审批 | 回复、工具结果、事件和任务状态 | 是否出现取决于当前 preset 与请求头；一次回答不等于任务交付 |
| 文件与 Shell | `read/write/edit/glob/grep`、Bash 或 PowerShell、后台 Job | 本机 Workspace 访问本机规范路径；云端文件工具只访问账号副本 | 路径策略、sandbox、命令策略和写入审批 | 文件变更、命令输出、后台任务日志 | 本机安全 preset 已装配；不会把目录静默复制到云端 |
| 网络与浏览器 | `web_search`、`web_fetch`、Electron 浏览器与 Chrome 共享标签页 | 由具备能力的 Host 或用户授权浏览器执行 | 网络访问、精确 Origin、登录态和页面副作用单独确认 | 页面内容、搜索结果或浏览器操作结果 | 共享 Web 工具有组装约定；浏览器、Chrome 与搜索路由规格仍含 `approved` 项 |
| 文档与产物 | `document_read`、`sheet_analyze`，以及 HTML、文档、幻灯片、表格、SVG、Mermaid 生成器 | 本机附件在账号专属设备 `DSH_HOME`；云端附件和生成器在云端 | 文件类型、大小、Session owner 和分析动作受限 | 摘要、表格分析、Artifact 与下载文件 | 本机文档分析和产物面板为 `implemented`；具体工具仍以组装后的 preset 为准 |
| Skill 与插件 | Skill 清单、发现、加载、目录安装、对话安装和账号扩展选择 | Skill 可由设备目录或账号存储提供 | 安装来源、账号权限、冲突规则和当前 Session 选择 | 已安装内容、模型指令、工具 schema 与调用结果 | 账号安装与本机目录管理为 `implemented`；安装清单不证明当前 Session 已加载 |
| 桌面体验 | 首页、对话、任务、审批、历史、设置、网站授权、共享标签页和更新 | main/preload/renderer 同时连接本机与云端 Host | IPC 白名单、CSP、认证闸门和断线恢复 | 状态、消息流、批准卡片、预览与恢复后的资源 | 认证闸门和流式连续性为 `implemented`；浏览器相关入口按各自规格验收 |
| 安全治理 | 账号切换、旧目录认领、owner、sandbox、审批、凭据保护与四层发布证据 | 运行时按 `authority + user` 派生，数据留在所属 Host | 认领决策、事件记录、能力清单和 fail-closed 路由 | 隔离目录、审计事件、验收与发布报告 | 本机运行时隔离为 `implemented`；联邦工具总规格为 `approved` |

这里的 Knowledge seam 只表示租户知识能力的可替换接口，不等于已经实现 RAG，也不说明当前产品已接入某个检索增强服务。`tool-capabilities` 只描述 bundle 对外声明的工具、位置和参数约束，不能替代真实账号、安装态和生产证据。

当前 `docs/specs/xiaowei` 一共有 18 份产品规格。把它们按状态合并后，可以看出“代码里出现了什么”和“产品已经交付了什么”仍是两件事：

| 状态 | 覆盖规格 |
| --- | --- |
| `implemented` | 账号扩展安装、账号 Workspace 隔离、Artifact 面板、桌面认证闸门、下行流连续性、邀请注册、本机目录导入、本机文档分析、本机交互可靠性、本机 Skill 目录、账号级本机运行时隔离、Workspace 导航交互 |
| `approved` | 账号 Web 搜索路由、Chrome 共享标签页、桌面浏览器、联邦工具能力、本机 Web 搜索、本机与云端 Workspace 总体环境 |

这张状态表是当前源码快照，不是生产发布清单。`implemented` 仍要继续核对组装、安装包和真实客户端；`approved` 只能说明方案进入了批准范围。

![小薇产品能力地图](/images/2026-08-31-xiaowei-series/00-product-capability-map.png)

[查看产品能力地图 HTML](/images/2026-08-31-xiaowei-series/00-product-capability-map.html)

小薇的账号能力位于 `packages/bundle/xiaowei`，桌面执行能力位于 `packages/bundle/xiaowei-local`。前者处理认证、账号根目录、钱包、模型密钥和云端能力；后者提供 Workspace 内文件、Shell、文档、表格、搜索、工作流和本机 Skill。

桌面端同时维护回环 `xiaowei-local` Host 和云端 Host。列表类请求会聚合两边结果，账号、钱包等方法固定走云端，Session 与 Artifact 等请求则按资源 ID 中的位置路由。两个 Host 共享 RPC 信封，但不共享数据归属。

## 详细设计：把一次任务拆成可观察资源

### 本机 E2E 流程

1. 登录并确认账号。
2. 创建位置为本机的 Workspace，添加测试目录。
3. 创建 Session，读取文本文件并生成摘要。
4. 检查工具结果、产物位置和事件。
5. 重启客户端，重新打开 Session 并核对 Workspace。

### 云端副本与附件 E2E 流程

1. 保持本机、云端两个 Host 同时连接，在创建 Workspace 时明确选择云端位置。
2. 使用 `workspace.importDirectory` 创建账号私有副本，记录返回的云端 Workspace ID。
3. 修改本机源目录，重新打开云端副本，确认它不会自动同步本机变化。
4. 另建一个本机 Session，上传小型 PDF 或 XLSX，执行文档或表格分析。
5. 检查本机附件与产物位于账号专属设备运行时；不要拿本机附件路径推断云端存储实现。

### 端到端任务流程

下面是一条适合首次验收的完整主线，输入是一个测试目录和一个明确任务，输出是可检查的文件、消息、事件和产物。

1. 登录账号，确认 principal、模型路由和钱包状态；本机 Host 不是离线模型。
2. 让 `DualHostRouter` 同时保持本机与云端 Host，创建本机 Workspace，并从列表中确认资源位置。
3. 创建 Session，提交“读取 `xiaowei-read-write.txt` 并生成摘要”的任务，明确哪些文件可以进入模型上下文。
4. Agent 根据当前 Session 组装工具清单和计划；模型可见输入应能由 Session 事件重建，不能把未记录的隐式状态当作上下文。
5. 执行读取；需要写入时等待审批，批准后再写回测试目录。搜索、浏览器和外部副作用属于独立能力，不能因为读文件已批准就自动放行。
6. 查看回复、工具结果、文件内容和产物。附件若来自本机，检查账号专属设备 `DSH_HOME`；若任务在云端 Workspace 中，检查云端对象，不用本机路径代替。
7. 重启客户端，再打开 Workspace 和 Session，核对事件、审批、文件和产物仍属于同一账号。只有这些检查同时通过，才判定任务完成。

这条流程把输入、执行位置、权限、输出和恢复检查放在同一条记录中。`workspace.list` 返回可用资源后再开始读写；仅看到端口监听或页面打开，不能证明 Host API 已经就绪。

![小薇端到端任务流程](/images/2026-08-31-xiaowei-series/00-end-to-end-task-flow.png)

[查看端到端任务流程 HTML](/images/2026-08-31-xiaowei-series/00-end-to-end-task-flow.html)

本机 Workspace 接收用户选择的规范路径，不枚举也不复制目录。上传的 PDF、DOCX、XLSX、PPTX 走单独的有界附件流程。Session 记录事件和能力选择，产物承载可继续使用的结果。

账号身份目录由 authority 与 user 派生。没有所有者的旧目录不自动分配：用户拒绝认领时进入干净账号目录，决定会被保存；用户确认认领时，系统把旧目录复制进该账号的运行时，原目录仍作为可恢复来源保留，并用认领标记阻止第二个账号重复导入。

登录后先确认账号，并创建位置为本机的 Workspace。在目录中准备 `xiaowei-read-write.txt`，让 Agent 先读取，再在审批提示出现时批准一次明确的写入操作。打开生成的产物，记录 Session 和路径；随后退出客户端并重启，重新打开 Session，检查文件、审批事件和产物仍属于同一账号。读成功只能证明读取，写入成功还要检查文件内容和权限。

本机目录是实时源，附件进入账号专属设备 DSH_HOME；云端 Workspace 是账号副本，云端附件留在云端存储。模型请求只发送用户有意加入的内容。本机模式仍走账号推理路由并消耗钱包，不应把“本机 Host”理解为离线模型。

## QA 与上线验收：四层证据不能混为一谈

### 源码与打包层

运行 `pnpm run typecheck`、`pnpm run test` 和 `pnpm run build`。这些命令证明源码和构建产物，不证明用户安装的客户端可用。打包层还要检查 profile、依赖闭包、main、preload 和 renderer。

### 验证清单

- [ ] 账号、环境和 Workspace 名称显示正确。
- [ ] 本机目录未被静默复制到云端。
- [ ] Session、请求、回复和产物重启后可见。
- [ ] 0.3.43 的隔离验收得到 `LOCAL_ACCOUNT_ISOLATION_043_OK`。
- [ ] `implemented`、`approved`、`observed` 在报告中分开。

本机账号隔离报告记录了 0.3.43 的安装、旧数据选择、真实模型回复、重启恢复，以及 macOS、Windows、Linux 产物。源码测试通过，不能替代安装态验证；安装包存在，也不能替代生产下载验证。

报告要写清命令、客户端版本、账号、Workspace、Session、输入文件和观察结果。源码层写 `pnpm run typecheck` 等命令；打包层写安装器和主进程导入；安装态层写真实登录、读写、审批和重启；生产层写版本对象、别名、安装脚本和清单。不能用“已验证”三个字覆盖四层差异。

## 踩坑：回答成功不等于发布成功

### 故障排查表

| 症状 | 检查 | 处理 |
| --- | --- | --- |
| 页面能开但服务缺失 | profile 与服务清单 | 重新核对组合包和依赖 |
| Workspace 列表为空 | Host API 就绪状态 | 等待 `workspace.list` |
| 历史串账号 | authority、user 和根目录 | 终止旧运行时并检查派生目录 |
| 更新器版本错误 | 版本文件、别名、清单 | 按发布顺序回退 |

0.3.40 的观察反馈是界面可打开，但实际服务缺失。误用 `dsh-ops` 也会把部署链路误当成产品能力。排障时必须回到 bundle、Host、客户端和生产下载四个实际路径。

迁移中最容易误判的是“服务能响应”。0.3.40 的本机点赞、点踩可以点击，却提示“反馈保存失败”。排查后定位到设备运行时没有挂载 `message-feedback` 服务。

修复后还要检查 `local-runtime/storages/message_feedback.json` 是否真的写入和清除。单看 `/health` 不足以完成这项检查。

另一个坑是部署时误跑了面向 `dsh-ops.service` 的脚本，而生产实际运行的是 `dsh-xiaowei.service`。最后一个坑是提前提升 `latest.json`：版本文件、稳定别名和安装脚本必须先核对，`latest.json` 最后更新，失败就停在版本化文件阶段。

## 认知迭代：小薇首先要对执行负责

### 最佳实践

先确认数据归属，再确认工具权限，最后确认结果位置。任何涉及外部副作用的动作都要有批准、撤销和失败提示。不要用一次模型回复替代任务验收。

`implemented` 表示对应规格已有实现证据；`approved` 表示方案获批或仍需验收；`observed` 只表示在某个版本、账号或客户端观察到的行为。本机仍需要账号推理，云端副本不自动同步。

## 参考资料与日常操作

### 首次使用记录模板

记录日期、客户端版本、账号、环境、Workspace、Session、输入文件、工具、审批、产物位置和结果。发现差异时，先保存事件和错误文字，再决定是否重连，避免用重试覆盖现场。

先阅读 `packages/bundle/xiaowei/README.zh.md`、`packages/bundle/xiaowei-local/README.zh.md` 和 `apps/desktop/README.zh.md`，了解产品组件和桌面边界。

再阅读 `docs/specs/xiaowei` 对应规格，最后查 `docs/ops/xiaowei-local-workspace-account-isolation-acceptance.zh.md`。博客是使用说明，不等同于官方发布声明。

版本文件先发布，确认内容和校验后更新稳定别名，再更新安装脚本，最后提升 `latest.json`。其中任一步失败都停在当前版本，不让更新器看到不完整清单。

首次试用从小文件和本机目录开始。确认重启恢复后，再建立云端副本；涉及浏览器、联网或 Skill 安装时，先查规格状态和审批要求。这样能把“能回答”与“能交付”分开记录。

产品评估不能只看模型和工具数量。实际验收后，优先级应放在归属、状态、恢复和证据。Workbuddy 的执行经验要求任务能继续，小薇的生产化还要求继续前能确定从哪里继续。

完成快速开始后，可继续阅读 01 篇的任务模板与交付判定，再按 02 篇验证账号切换和旧目录认领。不要在基础读写、审批和恢复尚未通过时直接扩大到生产目录。

客户端、Host 或清单检查失败时，先保留旧应用、用户数据和版本化产物，停止别名提升。首次操作完成后，在记录中标出每个对象的环境和 owner，再扩大文件范围或增加工具。
