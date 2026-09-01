---
title: "实战踩坑录 00 · 总览：把会话里趟过的坑整理成可检索的知识"
date: "2026-08-08"
description: "把过去几个月在 AI Coding / 工作台 / 桌面客户端 / 后端平台上踩过的真实问题，按主题聚类成 12 篇博文。每篇都来自一个具体会话的复盘，给出根因、现象与可复制的规避方案。"
tags: [AI Coding, 踩坑, 复盘, 系列, 工作流]
draft: true
---

## 一、为什么要做这个系列

AI 编程工具每天都在变，但「在真实工程里踩到的具体坑」不会因为模型升级而消失。同一类问题（多租户身份错配、Python `with` 上下文与回滚、Mac DMG Gatekeeper、CSS Grid 删除子元素留空白格、顺序 fallback 把 GitHub 压在队尾……）每过几周就会换个上下文重新出现。

把这些散落在不同会话、不同仓库、不同 `~/.claude/plans/*.md` 里的复盘集中整理一次，价值有三：

1. **检索性**：以后再遇到类似症状，能用关键词定位到「上次怎么解决的」。
2. **可复用性**：每篇都给出可立刻复制的规避代码或检查清单。
3. **不重复造轮子**：把同类问题合并（比如把「邮箱验证码全链路」和「前端 auth bootstrap」放在相邻的两篇），避免新人再次踩同一个家族的坑。

---

## 二、本系列怎么组织

按「问题从哪里来」分三层：

| 层级 | 问题来源 | 篇目 |
|---|---|---|
| **L1 · 语言/运行时** | 解释器、库、上下文管理器自带的行为 | 01 |
| **L2 · 系统/平台** | macOS 部署、Docker 卷、CSS Grid、邮箱/认证链路 | 02、03、04、10 |
| **L3 · 架构/工程** | 多 CLI 编排、AI 能力注册、RAG 链路组合、Skill 生命周期、内置与外挂的边界 | 05、06、07、08、11、12、13 |

每一篇的固定结构：

1. **症状**：当时看到了什么（错误信息、用户反馈、性能异常）。
2. **根因**：哪一行代码、哪一段配置、哪一种语义造成的。
3. **修复**：这次具体怎么处理的（关键 commit / 配置 / 代码片段）。
4. **可复用清单**：下次再遇到，能立即套用的检测手段或规避方案。

---

## 三、12 个主题（按出现频率排序）

| # | 主题 | 一句话总结 |
|---|---|---|
| 01 | [Python `with sqlite3.connect()` 异常回滚](2026-08-08-pitfalls-01-python-sqlite3-context-rollback.md) | 块内 `raise` 会回滚所有未提交写入；要在 raise 前显式 commit。 |
| 02 | [macOS DMG 部署：文件名大小写、Gatekeeper、MLX 后端](2026-08-08-pitfalls-02-macos-app-deploy-gatekeeper-mlx.md) | 下载页文档写小写、release 是大写；非公证 app 首次启动被拦；MLX/MPS 自动选错架构。 |
| 03 | [前端 demo 用户 vs 后端 seed 用户：401 ACTOR_NOT_FOUND](2026-08-08-pitfalls-03-frontend-auth-tenant-mismatch.md) | 前端 demo 账号用 `sales-101`，后端只 seed `tenant-a` 的演员；登录即 401。 |
| 04 | [CSS Grid 删了子元素还留空白格](2026-08-08-pitfalls-04-css-grid-orphan-cells.md) | 删除 JSX 后 `grid-template-columns` 三列还在，左右各一个空格子渲染成深色方块。 |
| 05 | [顺序 fallback 把 GitHub 压在队尾](2026-08-08-pitfalls-05-search-fallback-kills-github.md) | DDG/Bing 一旦有结果就停；GitHub 代码/issue 永远拿不到。技术查询要并行 fan-out。 |
| 06 | [两套 skill 体系生命周期不对齐](2026-08-08-pitfalls-06-two-skill-lifecycles-divergence.md) | prompt skill 有 propose/approve/install/uninstall，package skill 只有 enable/disable；统一注册/卸载入口。 |
| 07 | [客户端 zip 上传装 skill：单包 vs monorepo](2026-08-08-pitfalls-07-zip-install-skill-monorepo.md) | 解压假定 zip 根是一个 SKILL.md；要支持 multi-skill bundle + 路径穿越校验 + 临时载荷表。 |
| 08 | [内置 skill 被 Docker 卷遮蔽](2026-08-08-pitfalls-08-builtin-skills-vs-docker-volume.md) | 命名卷首次挂载后不再跟 image 同步更新；内置 skill 必须落在镜像层 + rsync include。 |
| 09 | [Codex `~/.codex/agents/*.toml` 当前版本不自动加载](2026-08-08-pitfalls-09-codex-subagent-toml-not-loaded.md) | 推文里的机制要等新版；当前靠 `AGENTS.md` 把调度约定写明白，主代理才能正确派发。 |
| 10 | [邮箱验证码全链路：生成、限流、锁定、SMTP 兜底](2026-08-08-pitfalls-10-email-verification-full-pipeline.md) | 6 位数字 + TTL 10 分钟 + 60s 重发冷却 + 1h 10 次上限 + 错 5 次锁 30 分钟；未配 SMTP 时落日志。 |
| 11 | [AI 能力补齐的统一注册模式](2026-08-08-pitfalls-11-agent-capability-registration-pattern.md) | Pydantic Input → async handler → CapabilityResult → registry.register_skill()；7 个新能力一晚上接完。 |
| 12 | [多 CLI 编排器从零设计：DAG + 状态机 + git worktree](2026-08-08-pitfalls-12-multi-cli-orchestrator-from-zero.md) | 每个 worker 独立 worktree；跨 worker 通信靠 artifact handoff；状态原子写 + 事件流。 |
| 13 | [RAG 链路 best-of-breed 组合](2026-08-08-pitfalls-13-rag-pipeline-composition.md) | 解析用 RAGFlow DeepDoc、分块用 RAGFlow、加权融合用 RAGFlow、插件化用 Dify、压缩用 OpenClaw。 |

---

## 四、读法建议

- **如果你赶时间**：从 01、03、04 开始读，这三个是「换个项目还会踩」的高频坑。
- **如果你在做 AI Coding 工具**：重点看 05、06、09、11、12，这五篇直接对应 agent runtime / skill 治理 / 多 CLI 协作的核心设计。
- **如果你在做产品交付**：看 02、07、08、10，这是真实部署/合规/扩展性问题。
- **如果你在做 RAG / 知识库**：直接读 13，再用 01 校一下你的存储写入逻辑。

---

## 五、写在最后

这一系列不是为了「证明踩过很多坑」，而是为了让每个坑只踩一次。下次再撞到类似症状，先来这里搜关键词——大概率前人已经把根因、修复和规避方案写清楚了。