---
title: "小薇数据与工作区指南：账号切换与认领"
date: "2026-08-31"
description: "说明本机源目录、云端副本和附件的生命周期，给出账号切换、旧目录拒绝或认领、复制保留与删除前复核的操作方法。"
tags: [小薇, 数据归属, Workspace, 隐私安全]
---

> **小薇平台分析 · 系列目录**
>
> [00 快速开始](/posts/2026-08-31-xiaowei-00-overview/) · [01 任务使用](/posts/2026-08-31-xiaowei-01-product-positioning/) · **02 数据与工作区** · [03 桌面发布](/posts/2026-08-31-xiaowei-03-product-governance-roadmap/) · [04 插件架构](/posts/2026-08-31-xiaowei-04-plugin-architecture/) · [05 双 Host](/posts/2026-08-31-xiaowei-05-desktop-dual-host/) · [06 Agent 运行时](/posts/2026-08-31-xiaowei-06-agent-runtime-sessions/) · [07 工具与产物](/posts/2026-08-31-xiaowei-07-tools-skills-artifacts/)

我先遇到的是一个很具体的故障：0.3.43 之前的本机运行时有串账号风险。换账号后，旧目录、Session 和历史不能靠“当前登录用户”猜测归属。修复后，我又把数据拆成三类：本机源目录、云端副本、上传附件。它们都叫 Workspace 相关数据，生命周期却不同。

这篇只讲用户走过的路径。我依据 `docs/specs/xiaowei/local-workspace-account-isolation.zh.md`、`apps/desktop/README.zh.md` 和本机验收报告复盘，不把 `approved` 规格写成已经交付的功能。

![小薇本机与云端的数据归属路径](/images/2026-08-31-xiaowei-series/02-product-workspaces-data.png)

[查看这张图的自包含 HTML](/images/2026-08-31-xiaowei-series/02-product-workspaces-data.html)

## 背景：0.3.43 之前我先看到串账号风险
### 先准备两个测试账号

本文适合处理本机文件、账号切换和 Workspace 导入的用户与验收人员。准备已认证账号、两个不同测试用户、一个本机目录和一份小型附件。不要直接拿生产目录做迁移试验。

### 对象说明

本机源目录是实时文件位置；云端副本是账号私有导入结果；附件是有界上传对象；Session 是事件和能力选择；产物是可打开的结果。它们不能用同一个路径推断。

本机运行时把数据放在 Electron 应用数据目录。只要账号身份没有进入运行时根目录，第二个账号就可能看到第一个账号的本机历史。这个问题不一定在登录页出现，往往要等 Session 列表或重启后才暴露。

我把检查点放在目录归属、Session owner、Workspace 请求字段和生命周期顺序，而不是只看端口是否监听。`workspace.list` 返回并不等于已经完成身份隔离。

## 目标与非目标：三分数据，拒绝自动认领
每个 Workspace、Session、附件和产物都要有明确的 owner 与 environment。authority、user、Session header 和 Host 一起决定权限；本机源目录保持实时，云端目录是账号私有副本，附件进入单独的有界存储。旧数据没有所有者时，必须先让用户选择。

系统不会静默上传本机目录，也不会让云端副本自动跟随本机变化。附件上传与 Workspace 导入是两条路径，不能拿一种大小限制去推断另一种能力。

## 方案设计：authority、user 与 Host 一起决定归属
### 状态表

| 对象 | 本机状态 | 云端状态 | 归属 |
| --- | --- | --- | --- |
| 目录 | 实时源 | 导入副本 | 资源 ID 中的位置 |
| 附件 | 设备有界引用 | 依实现和规格 | 当前 Session |
| Session | 设备事件 | 云端事件 | 创建环境 |
| 旧目录 | 待认领 | 不自动迁移 | 用户决定 |

DualHostRouter 同时维护双 Host，并按方法或资源 ID 路由。切换账号时先终止旧运行时，再按 authority+user 派生新根目录，等待 `workspace.list` 后加载资源。

本机运行时根据 authority 和 user 派生不透明身份目录。账号切换会先取消旧账号请求并停止旧本机 Host，再保存新凭证、广播认证状态，随后启动新账号运行时。新 Host 只有在 `workspace.list` 可用后才算产品就绪，端口监听不能提前放行。

桌面同时连接本机 `xiaowei-local` 与云端 Host。`workspace.list` 等列表会聚合，账号方法固定走云端，资源请求按位置标记返回原 Host。只有用户明确执行 `workspace.importDirectory`，才会建立账号私有的云端副本。

## 详细设计：源目录、云端副本和附件三条路径
### 本机 E2E 流程

1. 登录账号 A，确认本机、云端两个 Host 的列表都能返回或明确显示单边不可用。
2. 用 `workspace.create` 显式指定本机位置并添加测试目录。
3. 创建 Session，读取文件并写入结果。
4. 切换账号 B，确认 A 的 Workspace 和 Session 不出现。
5. 切回 A，确认重启后历史恢复。

### 云端与附件 E2E 流程

1. 保持双 Host 连接，在账号 A 下调用 `workspace.importDirectory` 创建云端副本。
2. 记录副本 ID，不把本机路径当作副本路径。
3. 修改本机目录，确认云端副本无自动变化。
4. 另建本机 Session，上传 PDF 或 XLSX，执行有界分析。
5. 检查附件和产物的本机 Session 归属，不把这条路径当成云端附件能力证明。

### 旧数据认领

拒绝旧目录后进入干净目录；选择认领时复制旧数据并保留原目录。拒绝结果要持久化，下一次启动不能重复提示，也不能删除原始备份。

### 数据传输与删除表

| 数据对象 | 创建与传输 | 删除或保留 | 复核方法 |
| --- | --- | --- | --- |
| 本机源目录 | 只传规范路径 | 用户文件系统 | 检查源文件 |
| 云端副本 | `workspace.importDirectory` | 云端 Workspace 规则 | 对照副本 ID |
| 本机附件 | 设备 DSH_HOME | Session 清理规则 | 检查设备存储 |
| Session 与产物 | 所在 Host 写入 | 资源存储策略 | 读取事件和结果 |

桌面端目录导入还有一组独立的默认限制：最多 200 个普通文件，单文件不超过 5 MiB，总量不超过 25 MiB。导入器在上传前拒绝符号链接和特殊文件，服务端还会重新校验相对路径、base64、重复路径、文件数量和字节数。这里的 5/25 MiB 是目录副本导入限制，不是文档附件解析上限。

Workspace 先处于创建或导入中，Host 就绪后才可使用；Session 创建后接收输入、工具事件和回复，结束后仍可恢复；附件先有暂存引用，分析成功后生成产物；账号切换不会把旧对象改写到新账号。删除前要确认对象 ID 和环境。

本机源目录只传规范路径，Host 直接访问同一目录。外部编辑和 Agent 编辑落在同一个源位置。云端导入则复制出一份账号私有数据，本机后续修改不会自动反映到云端。

附件是第三条路径。PDF、DOCX、XLSX、PPTX 的字节、暂存引用和生成的分析产物留在本机 Harness home；`document_read` 和 `sheet_analyze` 按当前 Session 读取有界内容。结果文件不能只藏在聊天回复里。

## QA 与上线验收：我怎样验证 0.3.43
- [ ] 账号 A、B 的本机根目录不同。
- [ ] 拒绝旧目录后出现干净目录。
- [ ] 认领时复制数据且原目录保留。
- [ ] 本机源、云端副本、附件三条路径可区分。
- [ ] 重启后 Session 和产物仍归属原环境。

源码层先运行聚焦测试、类型检查和主进程构建，检查账号身份键、owner 不匹配拒绝、拒绝结果持久化和启动顺序。打包层确认 Electron 包含 `local-runtime`，安装态层先备份原 `/Applications/小薇.app` 和完整用户数据。

验收时安装 0.3.43，对无所有者旧数据分别验证认领和拒绝路径：拒绝后进入干净目录，认领后旧数据只归当前账号，原目录保持不变。随后创建 `xiaowei-account-isolation-acceptance.A3xCSr` Workspace，得到真实回复 `LOCAL_ACCOUNT_ISOLATION_043_OK`，替换最终包并重启，确认 Workspace、Session、请求和回复首次加载就出现。

## 踩坑：端口、路径和导入名都可能误导
### 故障排查表

| 症状 | 检查 | 处理 |
| --- | --- | --- |
| 切账号后看到旧历史 | authority、user、运行时根目录 | 停止旧 Host，重新派生目录 |
| Workspace 列表为空 | `workspace.list` 是否就绪 | 等待产品 API，不只看端口 |
| 云端内容像本机最新版本 | 是否误把源目录当副本 | 核对导入时间和副本 ID |
| 附件被当作目录导入 | 调用名和字节限制 | 分开排查附件路径 |

0.3.43 安装态验证了旧数据选择、账号独立历史和重启恢复。它是特定版本、客户端和测试账号的 observed 证据，不能扩大为所有版本的保证。

第一个坑是把“端口监听”当成 Host 可用。实际要等待 `workspace.list`，因为产品 API 可能还没就绪。第二个坑是用旧的通用目录名做身份键，导致不同 authority 或 user 共享路径。

第三个坑是把目录导入和附件上传混成一条限制。目录是本机实时源，附件有自己的字节和解析上限；故障排查必须先确认调用的是 `workspace.create`、`workspace.importDirectory` 还是附件工具。

## 认知迭代：用户选择就是迁移记录
### 最佳实践

创建 Workspace 前先标注源目录或副本；上传附件时记录 Session；切换账号前备份本机数据；迁移完成后用另一账号验证不可见。

### 限制和状态

账号隔离、本机目录导入和文档分析规格是 `implemented`；本机 Workspace 环境规格是 `approved`。本机模型仍走账号推理和钱包，云端副本不自动同步。

我不再把迁移理解成一次移动文件的动作，而把它看作用户对归属的决定。拒绝、认领、复制、保留和恢复都必须留下可查记录。

## 参考配置与操作记录
### 首次配置

为每个测试账号记录 authority、user、Host、Workspace ID、Session ID、运行时根目录和模型路由。路径本身不应暴露给 renderer 或模型，只在受控日志中核对。

运行任务前看账号和环境，运行中看 Session 和审批，运行后看产物和事件。若发生异常，先保留目录、备份和错误，再决定是否切换 Host。

实现说明在 `packages/bundle/xiaowei-local/README.zh.md` 和 `apps/desktop/README.zh.md`；状态在 `docs/specs/xiaowei`；安装态证据在 `docs/ops/xiaowei-local-workspace-account-isolation-acceptance.zh.md`。

认领决定必须持久化，拒绝不能在下一次启动时消失，也不能用清理旧目录来掩盖归属不明。账号工作区隔离、本机目录导入和本机文档分析规格已有 `implemented` 记录；本机 Workspace 环境仍含 `approved` 项。0.3.43 的验收只证明该版本和该路径，不代表所有版本自动安全。

数据归属验证通过后，再进入 03 篇的安装态验收和发布流程。发布前仍要重新核对当前版本，不能把 0.3.43 的一次观察直接沿用为新版本结论。

### 账号切换教程

1. 记录账号、authority、user、Host 和 Workspace ID。

2. 等待请求结束或取消，保存错误和事件。

3. 登录测试账号 B，确认运行时按新的 authority+user 派生。

4. 等待 `workspace.list` 可用，确认账号 A 的资源不可见。

5. 遇到无所有者旧目录时选择拒绝或认领；认领后仍保留旧源。

6. 重启客户端，复查选择结果和资源列表。

切换账号或环境后，不要只看侧边栏名称。应重新请求 Workspace 列表，打开一个新 Session，再确认旧账号的资源不可见。复核通过后才可以继续处理附件或写入产物。若复核失败，保留原目录和备份，记录当前版本后再排障。
