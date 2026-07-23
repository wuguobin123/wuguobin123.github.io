---
title: "AI 中转站落地实践（十二）：反向代理到底在做什么——codex2api 的 4 层翻译原理"
date: 2026-07-23
description: "番外篇：把 ChatGPT Plus 订阅变成 API 给别人用，这件事为什么这么难？本篇用大量示意图拆解 AI API 反代（codex2api / kiro-rs / CLIProxyAPI）的 4 层翻译：协议转换、OAuth 身份、TLS 指纹、账号池调度。看完你就理解为什么直连永远 401、为什么需要 uTLS、为什么 Resin 是可选的。"
tags: [AI 中转站, 反向代理, codex2api, OAuth, TLS, 账号池]
draft: false
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · 03 网络打通 · 04 渠道配置 · 05 客户端使用 · 06 运维监控 · 07 合规与安全 · 08 容量规划 · 09 集群化 · 10 终篇 · 11 倍率体系 · **12 代理原理**

把 ChatGPT Plus 订阅"翻译"成 OpenAI API 这件事，为什么这么难？因为它**不是普通的 HTTP 反向代理**——普通 nginx 代理是把 HTTP 请求原样转发；AI 反代是**协议转换 + 身份伪装 + 指纹模拟**。

本篇用大量示意图，把 codex2api（以及同类的 kiro-rs、CLIProxyAPI）做的事拆给你看。

> ⚠️ **一个容易搞错的事**：codex2api 模拟的**不是浏览器 ChatGPT**，也不是它名字里的"codex"反代；它模拟的是 OpenAI 的另一个产品 **Codex CLI**（一个 Rust 写的命令行工具）。codex2api 把自己包装成 Codex CLI，去调 Codex CLI 的后端 `chatgpt.com/backend-api/codex/responses`。URL 里带 `chatgpt.com` 只是因为 OpenAI 后端架构统一，跟浏览器无关。

## 一、什么是"普通反向代理"和"AI 反向代理"的区别

### 普通反向代理

```
客户端                  代理服务器                 上游
  │                      │                       │
  │  GET /index.html     │                       │
  ├─────────────────────►│                       │
  │                      │  GET /index.html      │
  │                      ├──────────────────────►│
  │                      │                       │
  │                      │  200 OK + HTML        │
  │                      │◄──────────────────────┤
  │  200 OK + HTML       │                       │
  │◄─────────────────────┤                       │
  │                      │                       │
```

**特点**：HTTP 头、请求体、响应体**原样转发**，只是在网络层面换了一跳。

### AI 反向代理（codex2api / kiro-rs / CLIProxyAPI）

```
客户端                AI 反代                ChatGPT 后端
  │                    │                       │
  │  OpenAI 格式        │                       │
  │  POST /v1/chat/... │                       │
  │  Bearer sk-xxx     │                       │
  │  {model: gpt-5.5,  │                       │
  │   messages: [...]} │                       │
  ├───────────────────►│                       │
  │                    │  ChatGPT 内部格式      │
  │                    │  POST /backend-api/   │
  │                    │       codex/responses │
  │                    │  Bearer eyJhbGc...   │ ← 完全不同的 token
  │                    │  {model: gpt-5.5,    │
  │                    │   input: [...],      │ ← 字段名也变了
  │                    │   instructions: ...} │
  │                    ├──────────────────────►│
  │                    │                       │
  │                    │  ChatGPT 内部事件流   │
  │                    │  data: {type:        │
  │                    │   "output_text.delta",│
  │                    │   delta: "..."}      │
  │                    │◄──────────────────────┤
  │  OpenAI 格式流      │                       │
  │  data: {choices:   │                       │
  │   [{delta:         │                       │
  │   {content:"..."}}]│                       │
  │◄───────────────────┤                       │
```

**特点**：**协议、身份、字段名、流式事件**全部要在中途翻译。**这是 4 层不同的"翻译"叠加在一起**。

## 二、Layer 1：协议转换（Protocol Translation）

OpenAI Chat Completions 和 ChatGPT 内部 codex API **长得完全不一样**：

### 请求对比

```jsonc
// OpenAI 公共 API（你客户端发的）
POST /v1/chat/completions
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "hi"}
  ],
  "stream": true
}

// ChatGPT 内部 codex API（codex2api 实际发的）
POST /backend-api/codex/responses
{
  "model": "gpt-5",
  "instructions": "You are helpful",       // ← system 单独提出来
  "input": [                                 // ← 字段名变了
    {"role": "user", "content": "hi"}
  ],
  "stream": true
}
```

### 响应对比

```jsonc
// ChatGPT 内部 SSE 事件
data: {"type":"response.output_text.delta","delta":"hi"}

data: {"type":"response.output_text.delta","delta":" there"}

data: {"type":"response.completed","response":{...}}

// OpenAI 格式 SSE 事件（codex2api 翻译后给你的）
data: {"choices":[{"delta":{"content":"hi"}}]}

data: {"choices":[{"delta":{"content":" there"}}]}

data: {"choices":[{"finish_reason":"stop"}],"usage":{...}}

data: [DONE]
```

### 翻译逻辑（伪代码）

```python
def openai_to_codex(req: dict) -> dict:
    messages = req["messages"]
    system = next((m["content"] for m in messages if m["role"] == "system"), None)
    rest   = [m for m in messages if m["role"] != "system"]

    return {
        "model": req["model"],
        "instructions": system or "",
        "input": rest,
        "stream": req.get("stream", False),
        # ... 字段一一映射
    }

def codex_event_to_openai(event: dict) -> dict | None:
    if event["type"] == "response.output_text.delta":
        return {"choices": [{"delta": {"content": event["delta"]}}]}
    if event["type"] == "response.completed":
        usage = event["response"]["usage"]
        return {
            "choices": [{"finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": usage["input_tokens"],
                "completion_tokens": usage["output_tokens"],
                "total_tokens": usage["total_tokens"],
            },
        }
    return None  # 其他事件类型丢弃或转成 [DONE]
```

**客户端完全感受不到差异**——发的是标准 OpenAI 格式，收的也是标准格式。

## 三、Layer 2：身份转换（OAuth + Token 管理）

这是**为什么直接贴 access_token 永远 401** 的根因。

### 不同 token 的用途

```
ChatGPT 后端的"门禁系统"（简化）：

  ┌─────────────────────────────────────────────────────────────┐
  │                       ChatGPT.com                            │
  │                                                              │
  │  门 1 (公共门)         门 2 (内部业务门)        门 3 (高级门)  │
  │  /api/auth/session    /backend-api/wham/...   /backend-api/  │
  │  /api/auth/refresh    /backend-api/codex/...   codex/admin/  │
  │                                                              │
  │  需要：session JWT     需要：internal JWT      需要：代理 IP   │
  │        (公开)             (OAuth 兑换)              (Resin)    │
  └─────────────────────────────────────────────────────────────┘
```

| Token 类型 | 来源 | 能开哪扇门 | 时效 |
|-----------|------|-----------|------|
| session JWT（带 `eyJ...`） | `/api/auth/session` | 门 1 | 1 小时 |
| access_token JWT（带 `eyJ...`） | session JWT 内部附带 | 门 1 + 部分门 2 | 1 小时 |
| **internal access_token**（带 `eyJ...`） | **OAuth PKCE 兑换** | **门 1 + 门 2** | **1 小时** |
| **refresh_token**（带 `rt-...`） | **OAuth PKCE 兑换** | **可以换新 access_token** | **数月** |

**关键事实**：codex2api 调用的 `wham/usage`、`codex/responses` 都在**门 2**，需要的是 internal access_token，**只能通过 OAuth PKCE 流程拿到**。

### OAuth 完整流程

```
用户                       codex2api                  OpenAI OAuth
  │                          │                            │
  │  1. 我要加账号           │                            │
  ├─────────────────────────►│                            │
  │                          │  2. 生成 PKCE challenge    │
  │                          ├───────────────────────────►│
  │                          │                            │
  │  3. 浏览器打开授权 URL    │                            │
  │◄─────────────────────────┤                            │
  │     (含 challenge)       │                            │
  │  4. 登录 chatgpt.com      │                            │
  │     点击"同意授权"        │                            │
  ├───────────────────────────────────────────────────────►│
  │                          │                            │
  │                          │  5. 重定向到                │
  │                          │     localhost:1455/         │
  │                          │     auth/callback?code=...  │
  │                          │◄───────────────────────────┤
  │                          │                            │
  │  6. 用户复制 callback URL │                            │
  ├─────────────────────────►│                            │
  │                          │  7. POST /oauth/token      │
  │                          │     code + verifier        │
  │                          ├───────────────────────────►│
  │                          │                            │
  │                          │  8. 返回:                   │
  │                          │     - access_token (1h)    │
  │                          │     - refresh_token (多月) │
  │                          │     - id_token (含 user)   │
  │                          │◄───────────────────────────┤
  │                          │                            │
  │  9. 完成                  │                            │
  │◄─────────────────────────┤                            │
  │                          │                            │
  │                          │  ── 每 10 分钟后台 ──       │
  │                          │                            │
  │                          │  10. 检测到 access_token   │
  │                          │      将在 30 min 内过期    │
  │                          │                            │
  │                          │  11. POST /oauth/token    │
  │                          │      grant_type=           │
  │                          │      refresh_token         │
  │                          ├───────────────────────────►│
  │                          │                            │
  │                          │  12. 返回新 access_token   │
  │                          │◄───────────────────────────┤
  │                          │                            │
  │                          │  13. 替换内存中的 token   │
```

### Token 自动续命

```go
// auth/store.go (伪代码)
func (s *Store) autoRefreshLoop() {
    ticker := time.NewTicker(10 * time.Minute)
    for range ticker.C {
        for _, acc := range s.accounts {
            if time.Until(acc.AccessTokenExpiresAt) < 30*time.Minute {
                // 用 refresh_token 换新 access_token
                newTokens, err := refreshOAuthToken(acc.RefreshToken)
                if err != nil {
                    log.Printf("account %d refresh failed: %v", acc.ID, err)
                    acc.Status = StatusError
                    continue
                }
                acc.AccessToken = newTokens.AccessToken
                acc.RefreshToken = newTokens.RefreshToken  // 可能轮换
                acc.AccessTokenExpiresAt = time.Now().Add(newTokens.ExpiresIn)
                log.Printf("account %d auto-refreshed", acc.ID)
            }
        }
    }
}
```

## 四、Layer 3：TLS 指纹伪装（uTLS）

**这是 ChatGPT 反爬虫的关键防线**，也是 OpenAI 能区分"真浏览器 vs 脚本"的核心机制。

### TLS 握手是什么

每次 HTTPS 请求前，客户端要先发一个 ClientHello 消息，里面包含：

```
TLS ClientHello
├─ TLS Version:    TLS 1.3
├─ Cipher Suites:  [13 个密码套件的优先级排序]
├─ Extensions:     [16 个扩展的精确组合和顺序]
│  ├─ server_name (SNI)
│  ├─ extended_master_secret
│  ├─ supported_versions
│  ├─ psk_key_exchange_modes
│  ├─ application_settings
│  └─ ...
├─ Elliptic Curves: [曲线列表及其偏好]
├─ Signature Algorithms: [签名算法列表]
└─ ALPN: h2, http/1.1
```

**不同客户端的 ClientHello 字段组合是唯一的**，可以哈希成一个指纹（JA3 hash）。

### 不同客户端的 JA3 指纹对比

```
Go net/http 默认:                Chrome 130 浏览器:
  TLS_AES_128_GCM_SHA256: 1       TLS_AES_128_GCM_SHA256: 1
  TLS_AES_256_GCM_SHA384: 2       TLS_CHACHA20_POLY1305_…: 2
  ...                             TLS_AES_256_GCM_SHA384: 3
  13 个密码套件（特定顺序）       17 个密码套件（Chrome 特征顺序）

  Extensions: 8 个                Extensions: 16+ 个
  (Go 精简版)                    (Chrome 全功能版)

  JA3 Hash:                      JA3 Hash:
  771,4865-4866-4867-...,        771,4865-4867-4866-...,  
  aaaa...                        bbbb...  ← 完全不同
```

**ChatGPT 后端的判定逻辑**（简化）：

```
JA3 Hash = "Go 标准库特征" ?
   ├─ 是 + 请求来自 chatgpt.com/backend-api/* ?
   │    └─ 是 → 403 Forbidden（看起来不像浏览器）
   └─ 否 → 放行
```

### uTLS 如何解决

```go
import (
    "github.com/refraction-networking/utls"
)

// proxy/executor.go (伪代码)
func newCodexTransport() http.RoundTripper {
    return &http.Transport{
        TLSClientConfig: &utls.Config{
            // 指定模拟的浏览器 Profile
            ClientHelloSpec: &utls.HelloChrome_130,

            // 等价于：用 Chrome 130 的 ClientHello 字段组合
            // 包括密码套件、扩展顺序、椭圆曲线、签名算法等
        },
        // 同时 HTTP/2 也要模拟（指纹扩展）
        DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
            return utls.DialWithHello(ctx, network, addr, &utls.HelloChrome_130)
        },
    }
}
```

```
修改前:                              修改后:
                                  
Go HTTP 客户端                       Go HTTP 客户端
    │                                   │
    ├─ TLS ClientHello                  ├─ TLS ClientHello
    │   (Go 指纹)                       │   (Chrome 指纹)
    │   JA3: aaaa...                    │   JA3: bbbb...
    │                                   │
    ▼                                   ▼
ChatGPT 后端: "脚本！" 拒绝          ChatGPT 后端: "Chrome 浏览器" 放行
```

加上正确的 HTTP Header：

```go
req.Header.Set("User-Agent", "codex_cli/0.118.0 (linux; x86_64) apple_terminal")
req.Header.Set("Accept", "text/event-stream")
req.Header.Set("Accept-Language", "en-US,en;q=0.9")
req.Header.Set("Originator", "codex_cli_rs")
req.Header.Set("Session_id", uuid.New().String())  // 每次请求新 UUID
req.Header.Set("Connection", "keep-alive")
```

这些都让 ChatGPT 后端**看到一个真正的 Codex CLI 在调用**。

## 五、Layer 4：账号池调度

单账号场景这层是空的。多账号时是完整的调度系统：

```
                  ┌──────────────────────────────────┐
                  │     调度器 (Scheduler)            │
                  │                                  │
请求 ─────────────►│  1. 模型支持过滤                  │
                  │  2. 健康状态过滤 (排除 banned)    │
                  │  3. 配额窗口过滤 (5h/7d 未超)     │
                  │  4. 冷却状态过滤                  │
                  │  5. 加权随机选择                  │
                  │                                  │
                  └────────────┬─────────────────────┘
                               ▼
              ┌────────────────────────────────────────┐
              │           账号池状态机                   │
              ├────────────────────────────────────────┤
              │                                        │
              │  ┌─────────┐                            │
              │  │  Ready  │ ── 限速响应 429 ──┐         │
              │  │ (可用)   │                  │         │
              │  └─────────┘                  ▼         │
              │      ▲                  ┌──────────┐     │
              │      │                  │Cooldown  │     │
              │      │                  │(冷却中)   │     │
              │      │ 冷却时间到        └─────┬────┘     │
              │      └────────────────────────┘         │
              │                                         │
              │  ┌─────────┐                             │
              │  │  Error  │ ◄── 401/403/网络错误        │
              │  │ (错误)   │                            │
              │  └─────────┘                            │
              └─────────────────────────────────────────┘
```

每账号的并发上限是 2（`MaxConcurrency=2`），通过令牌桶限速。

## 六、Resin 是什么（可选第 5 层）

**没有 Resin（默认）**：

```
codex2api ──(uTLS Chrome 指纹)──► chatgpt.com
                                    ▲
                                    │
                              OpenAI 反爬虫:
                              "JA3 指纹看起来像 Chrome,
                               token 是 OAuth 颁发的,
                               放行"
```

**有 Resin**：

```
codex2api ──► Resin 反代 ──► chatgpt.com
              (专门跑)
                │
                ├─ 真实 Chrome headless 实例（不是 uTLS 模拟）
                ├─ 真实 IP 池（每个账号分配不同出口 IP）
                ├─ 真实 Cookie 持久化
                └─ 真实 WebSocket 长连接
```

### Resin 何时必须

| 场景 | 单账号 | 5 个账号 | 50+ 账号 |
|------|--------|----------|----------|
| 低频个人使用 | 不需要 | 不需要 | 不需要 |
| 团队小流量 | 不需要 | 不需要 | 建议 |
| 池子轮询高并发 | 建议 | 强烈建议 | 必须 |
| 被 OpenAI 风控过的 IP | 建议 | 必须 | 必须 |

我们 1 个账号 + 低频 = **不需要 Resin**。codex2api 内置的 uTLS 已经足够。

## 七、整体架构一张图

```
                     ┌───────────────────────┐
                     │ 客户端 (CC Switch 等)   │
                     └───────────┬───────────┘
                                 │ OpenAI 格式
                                 ▼
    ┌────────────────────────────────────────────────┐
    │              codex2api                          │
    │                                                │
    │  ┌──────────────────────────────────────────┐  │
    │  │  Layer 1: 协议转换                        │  │
    │  │  OpenAI Chat Completions ⇄ Codex Responses│  │
    │  └──────────────────────────────────────────┘  │
    │                     ↓                          │
    │  ┌──────────────────────────────────────────┐  │
    │  │  Layer 2: 身份转换                        │  │
    │  │  账号池 + OAuth 自动刷新                  │  │
    │  └──────────────────────────────────────────┘  │
    │                     ↓                          │
    │  ┌──────────────────────────────────────────┐  │
    │  │  Layer 3: TLS 指纹伪装                    │  │
    │  │  uTLS Chrome 130 模拟                    │  │
    │  └──────────────────────────────────────────┘  │
    │                     ↓                          │
    │  ┌──────────────────────────────────────────┐  │
    │  │  Layer 4: 账号池调度 (可选)               │  │
    │  │  健康度评分 + 配额窗口 + 冷却恢复         │  │
    │  └──────────────────────────────────────────┘  │
    │                     ↓                          │
    │  ┌──────────────────────────────────────────┐  │
    │  │  Layer 5: Resin 反代 (可选)               │  │
    │  │  仅在多账号高并发场景需要                  │  │
    │  └──────────────────────────────────────────┘  │
    │                                                │
    └─────────────────────┬──────────────────────────┘
                          │ ChatGPT 内部格式
                          ▼
                  chatgpt.com
```

## 八、为什么"普通反向代理"做不到这件事

| 能力 | nginx | codex2api |
|------|-------|-----------|
| HTTP 头转发 | ✅ | ✅ |
| 流式响应透传 | ✅（要关缓冲） | ✅ |
| **OpenAI 格式 ↔ codex 格式翻译** | ❌ | ✅ |
| **OAuth 自动续命** | ❌ | ✅ |
| **uTLS 指纹伪装** | ❌ | ✅ |
| **账号池调度** | ❌ | ✅ |
| **配额窗口追踪** | ❌ | ✅ |

nginx 只能做"字节转发"，codex2api 做的是"语义翻译"。**前者是邮递员，后者是翻译官**。

## 小结

把 ChatGPT 订阅变成 OpenAI API 看似是"换个端口转发"，实际涉及：

1. **协议转换**：客户端 OpenAI 格式 ⇄ ChatGPT 内部格式
2. **身份转换**：sk-xxx ⇄ OAuth internal JWT，OAuth 流程给长期 refresh_token 让自动续命成为可能
3. **TLS 伪装**：uTLS Chrome 指纹让后端认为是真浏览器
4. **账号调度**：多账号场景的健康度、配额、冷却智能管理
5. **Resin（可选）**：极端高并发场景的真实浏览器/IP 池模拟

每一个层都不可省略——这就是为什么"自建 ChatGPT 反代"从来不是一个简单的 nginx 配置就能搞定的事。

