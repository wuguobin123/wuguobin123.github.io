---
title: "用 AI 和开源工具，30 分钟搭一个个人博客"
date: "2026-07-17"
description: "Cloudflare、GitHub Pages、Obsidian 与 AI 的最短组合：先免费上线，再决定要不要买域名。"
tags: [AI, 开源, 博客, GitHub Pages]
---

个人博客不需要先买服务器，也不需要先研究一套复杂的内容管理系统。对个人写作者来说，一套足够轻、足够透明的组合是：

> Obsidian 负责写作，Markdown 负责保存，GitHub 负责版本管理，GitHub Pages 负责托管，Cloudflare 负责域名与 DNS，AI 负责界面和重复劳动。

## 先用免费的地址跑起来

最容易拖慢进度的事情，是一开始就在域名、框架和主题里反复选择。我的顺序是：

1. 先创建一个公开 GitHub 仓库；
2. 用 GitHub Pages 得到免费的 `username.github.io/repository` 地址；
3. 确认文章、导航和手机端显示都正常；
4. 最后再决定是否购买独立域名。

这样做的好处是，每一步都有可见结果。即使暂时不买域名，网站也已经可以分享。

## Obsidian 就是后台

这个博客没有传统后台。`content/posts` 文件夹就是文章库：

```text
content/posts/
├── 2026-07-17-build-a-blog-in-30-minutes.md
├── 2026-07-12-ai-product-is-a-workflow.md
└── _template.md
```

把整个项目文件夹作为 Obsidian 仓库打开，复制模板、写文章、保存，然后提交到 GitHub。自动发布流程会完成剩下的工作。

## 让 AI 做什么

AI 最适合承担三类工作：

- 根据个人定位生成界面和信息结构；
- 把 Markdown 内容接进网站并处理响应式布局；
- 写好自动发布配置、检查构建错误、整理域名操作步骤。

但个人介绍、项目判断和文章观点仍然应该来自本人。AI 可以把表达做得更清楚，不能替你形成经历。

## 接入自己的域名

网站稳定后，再到 Cloudflare Registrar 购买域名，或把已有域名接入 Cloudflare。先在 GitHub Pages 填入自定义域名，再在 Cloudflare DNS 创建 GitHub 要求的记录。

根域名需要指向 GitHub Pages 当前公布的四个 IPv4 地址：`185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153`；`www` 子域使用 CNAME 指向 `wuguobin123.github.io`，不要带仓库名。

域名与证书生效通常需要一点时间，DNS 传播最长可能需要 24 小时。切换期间不要删除免费的 GitHub Pages 地址，它仍然是最可靠的回退入口。

## 这套方案的长期成本

GitHub 仓库、GitHub Pages、Obsidian 和这套博客代码都可以免费使用。唯一通常需要持续付费的是独立域名；如果继续使用 GitHub Pages 免费地址，基础设备费用可以保持为零。

重点不是“30 分钟做完所有东西”，而是在 30 分钟内拥有一个真实、可迭代、自己掌控的数据起点。
