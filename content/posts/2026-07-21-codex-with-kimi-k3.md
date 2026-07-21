---
title: "AI Coding 实战 05｜从 0 到 1 在 Codex 中接入 Kimi K3"
date: "2026-07-21"
description: "系列第 5 篇：用 CC Switch 把 Kimi Code 编程会员的 K3 模型接入 Codex，绕过新版 Codex 强制 Responses 协议与 Kimi 只提供 Chat 接口的冲突，附完整排障记录。"
tags: [AI Coding, Codex, Kimi K3, CC Switch, 效率工具]
---

> **AI Coding 实战系列 · 第 5 篇**
>
> [01 两天做完小程序](/posts/2026-07-19-build-wechat-mini-program-in-two-days/) · [02 六阶段提效](/posts/2026-07-20-from-tweet-to-miniprogram/) · [03 手机远程控制](/posts/2026-07-20-control-chatgpt-from-phone/) · [04 产品设计做减法](/posts/2026-07-20-product-design-by-subtraction/) · **05 本篇**

手上有 Kimi 会员附带的 Kimi Code 编程权益，又有 ChatGPT 的 Codex 作为日常编程工具，自然会想：能不能让 Codex 直接跑 Kimi 最新的 K3 模型？

答案是能，但不是"填个 Key 就完事"。实际走一遍会踩到三个坑，每一个的报错信息都指向错误的方向。本文把完整过程和排障思路整理出来，照着做一遍大概十分钟。

## 先讲清楚三个坑

### 坑一：Kimi 有两个平台，地址完全不同

- **Kimi 开放平台**：`https://api.moonshot.cn/v1`，按量付费，充值即用；
- **Kimi Code 编程会员**：`https://api.kimi.com/coding/v1`，会员订阅制，专为编程场景设计。

Kimi Code 控制台生成的 Key（`sk-kimi-` 开头）**只能用于后者**。如果把它填到 `api.moonshot.cn`，会直接报：

```
401 Invalid Authentication
```

反过来，如果你的 Key 在 moonshot.cn 上报 `suspended due to insufficient balance`，说明它属于开放平台按量账户，余额不足——这和会员权益是两套计费。

### 坑二：模型 ID 是 `k3`，不是 `kimi-k3`

Kimi Code API 提供三个模型 ID：

| 模型 ID | 说明 | 会员要求 |
| --- | --- | --- |
| `k3` | Kimi K3，支持 low / high / max 三档思考 | Moderato 及以上 |
| `kimi-for-coding` | Kimi K2.7 Code | 所有会员 |
| `kimi-for-coding-highspeed` | K2.7 Code 高速版 | Allegretto 及以上 |

### 坑三：协议不匹配（最关键）

Kimi Code API 只提供 OpenAI **Chat Completions** 接口；而新版 Codex 已经移除了 `wire_api = "chat"`，强制要求 `wire_api = "responses"`。直接配置会在启动时报：

```
invalid configuration: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
```

但把 `wire_api` 改成 `responses` 直连 Kimi 又是不行的——`api.kimi.com/coding/v1/responses` 这个端点根本不存在。

解法就是 Kimi 官方推荐的做法：**开启 CC Switch 的本地路由（Local Routing），由它在 Responses 与 Chat Completions 之间做实时协议转换**。整体链路：

```
Codex ──Responses──> CC Switch 本地路由(127.0.0.1:15721) ──Chat Completions──> api.kimi.com/coding/v1
```

## 配置四步走

### 第一步：获取 API Key

进入 Kimi Code 控制台，点击「新建 API Key」，复制生成的 `sk-kimi-` 开头的 Key 并妥善保存——**关闭弹窗后无法再次查看完整 Key**。

### 第二步：在 CC Switch 中添加 Codex 供应商

打开 CC Switch，顶部切换到 **Codex** 标签页，点右上角 **+** 添加供应商：

- **API Key**：刚才复制的 `sk-kimi-...`
- **Base URL**：`https://api.kimi.com/coding/v1`
- **Model**：`k3`

保存并切换到该供应商。CC Switch 会把它写入 `~/.codex/auth.json` 和 `~/.codex/config.toml`。

### 第三步：开启本地路由（关键）

在 CC Switch 中打开 **Settings > Routing**：

1. 打开 **Routing Master Switch**，启动本地路由（默认监听 `127.0.0.1:15721`）；
2. 在 **Routing Enabled** 下打开 **Codex**；
3. 确认该供应商的上游 API 格式标记为 `openai_chat`——这是告诉路由"上游说 Chat 协议，请帮我转换"。

开启后 Codex 的实际配置应该是这样（`~/.codex/config.toml`）：

```toml
model_provider = "custom"
model = "k3"
model_reasoning_effort = "high"

[model_providers.custom]
name = "custom"
wire_api = "responses"                  # Codex 侧必须是 responses
base_url = "http://127.0.0.1:15721/v1"  # 指向本地路由，而不是直连 Kimi
requires_openai_auth = true
```

### 第四步：验证

先确认路由在监听：

```bash
lsof -iTCP:15721 -sTCP:LISTEN
```

再模拟 Codex 发一个 Responses 请求做端到端测试：

```bash
curl -s http://127.0.0.1:15721/v1/responses \
  -H "Authorization: Bearer sk-kimi-你的Key" \
  -H "Content-Type: application/json" \
  -d '{"model":"k3","input":"回复ok两个字","store":false}'
```

返回里看到 `"status":"completed"` 和 `"text":"ok"` 就说明全链路通了，打开 Codex 即可使用 K3。

## 报错速查表

| 报错 | 真实原因 | 解法 |
| --- | --- | --- |
| `401 Invalid Authentication` | Key 与地址不匹配，把 Kimi Code 的 Key 填到了 `api.moonshot.cn` | Base URL 改为 `https://api.kimi.com/coding/v1` |
| `suspended due to insufficient balance` | 走的是开放平台按量账户，余额不足 | 编程会员走 `api.kimi.com/coding/v1`；或去开放平台充值 |
| `wire_api = "chat"` is no longer supported | 新版 Codex 移除了 chat 协议 | 开启 CC Switch 本地路由，Codex 侧用 `responses` 指向 `127.0.0.1:15721/v1` |
| Connection refused / 超时 | CC Switch 被退出，路由进程随之停止 | 使用期间保持 CC Switch 运行 |
| `resource_not_found_error`（直连 `/responses`） | Kimi Code API 没有 responses 端点 | 必须经过本地路由转换，不能直连 |

## 几个注意点

- **CC Switch 必须保持运行**，本地路由进程由它提供，退出它 Codex 就断连。
- **会员档位决定能力上限**：`k3` 需 Moderato 及以上；Allegretto 及以上可解锁 K3 的 100 万上下文。
- **不要篡改客户端标识（User-Agent）**，官方明确这属于违规，可能导致权益暂停。
- CC Switch 是第三方开源工具，API Key 和请求会经过它的本地路由，有合规要求的环境请先自行评估。

## 参考

- [Kimi Code 官方文档](https://www.kimi.com/code/docs/)
- [Kimi 开放平台：Codex CLI 接入 Kimi K3 指南](https://platform.kimi.ai/docs/guide/codex-kimi)
- [在第三方 Coding Agent 中使用 Kimi Code](https://www.kimi.com/code/docs/third-party-tools/other-coding-agents.html)
