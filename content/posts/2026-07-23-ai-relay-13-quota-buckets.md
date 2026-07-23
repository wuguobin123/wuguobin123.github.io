---
title: "AI 中转站落地实践（十三）：为什么 Plus 订阅"额度用光"了，部分模型还能调通？"
date: 2026-07-23
description: "番外篇：用 4 层桶架构解释 ChatGPT Plus 的额度系统——聊天桶、Codex 桶、图像桶、高级推理桶独立计数；Tier 1/2/3 模型分级；codex2api 如何读 wham/usage 数据做调度；以及这对中转站运营者的实操影响。"
tags: [AI 中转站, ChatGPT Plus, 配额, 桶架构, codex2api, 模型分级]
draft: false
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · 03 网络打通 · 04 渠道配置 · 05 客户端使用 · 06 运维监控 · 07 合规与安全 · 08 容量规划 · 09 集群化 · 10 终篇 · 11 倍率体系 · 12 代理原理 · **13 配额桶架构**

上一篇讲完 codex2api 的 4 层翻译原理后，很多读者会问一个自然的问题：

> "我用 ChatGPT Plus 调 codex2api，网页端提示额度用光了，为什么 gpt-5.5 / gpt-5.4-mini 还能调通？"

答案藏在 ChatGPT Plus 的**额度桶（quota bucket）架构**里。这篇文章把整个系统拆给你看。

## 一、破除误区："额度用光"不是全局开关

我们日常看到的"额度用光"其实是口语化的简化表达。技术上，**ChatGPT Plus 至少有 4 个独立的额度桶**，每个桶独立计数、独立耗尽、互不影响。

```
┌──────────────────────────────────────────────────────┐
│             ChatGPT Plus 订阅                         │
│              （单一订阅，多个桶）                       │
│                                                       │
│   ┌─────────────────┐    ┌──────────────────┐         │
│   │ 桶 1: 聊天       │    │ 桶 2: Codex       │         │
│   │                  │    │                  │         │
│   │ 给 chatgpt.com   │    │ 给 codex_cli      │         │
│   │ 网页前端         │    │ 命令行工具        │         │
│   │                  │    │ (codex2api 也用)   │         │
│   └─────────────────┘    └──────────────────┘         │
│                                                       │
│   ┌─────────────────┐    ┌──────────────────┐         │
│   │ 桶 3: 图像       │    │ 桶 4: 高级推理    │         │
│   │                  │    │                  │         │
│   │ gpt-image-2      │    │ o1-pro           │         │
│   │ 图像生成专用     │    │ gpt-5.6-high     │         │
│   │                  │    │ 等重型模型         │         │
│   └─────────────────┘    └──────────────────┘         │
│                                                       │
└──────────────────────────────────────────────────────┘
```

每个桶的容量、重置规则、消耗速度都不同。"网页提示额度用光"指的是 **桶 1 满了**，但其他 3 个桶的状态完全独立。

## 二、桶 1：聊天桶（最容易被填满）

```
聊天桶详细规格：

  ┌─────────────────────────────────────┐
  │ 窗口：5 小时滚动                     │
  │ 容量：约 80 条消息（GPT-5）          │
  │       无限条（GPT-5 mini）           │
  │ 重置：每 5 小时从最新消息往后推       │
  │ 状态：网页 UI 显式展示                │
  └─────────────────────────────────────┘
  
  输入消息 1
  输入消息 2  
  ...
  输入消息 80
  ┌─────────────────────────────────┐
  │ ⚠️ 你已用完 5 小时配额           │ ← 网页提示
  │ 2 小时 14 分后可继续使用         │
  └─────────────────────────────────┘
  
  时间推进...
  5 小时后，消息 80 滑出窗口
  输入消息 81  ← 又能用了
```

**特点**：

- 网页端、API key（OpenAI 官方）共用这个桶
- 在网页 chatgpt.com 显眼位置显示进度条
- "用光"的标准用户体验就是看到这条提示

## 三、桶 2：Codex 桶（与聊天桶完全独立）

**这是关键认知**：ChatGPT Plus 订阅里**同时包含** Code 套餐的额度，OpenAI 把它们当作**两个独立产品**卖给 Plus 用户。

```
为什么是独立桶？
═══════════════

OpenAI 业务侧的理由：
  - ChatGPT 网页面向"普通用户"
  - Codex CLI 面向"开发者/工程师"
  - 两类用户行为模式完全不同（网页聊天少，CLI 调用多）
  - 不应该让开发者的重度使用卡死普通用户的聊天体验
```

所以：

```
Plus 用户的"总权益"：

  ┌─────────────────────┐
  │ ChatGPT 网页聊天      │ ← 桶 1，5h 滚动
  │ （80 条 GPT-5 / 5h）  │
  ├─────────────────────┤
  │ Codex CLI 调用       │ ← 桶 2，**完全独立**
  │ （额度更宽松）         │
  └─────────────────────┘

两个桶互不感知对方状态。
```

这就是你看到的"网页说满了，codex 还能调"的**根本原因**——它们走的是两套计数器。

## 四、桶 2 内部还分模型 Tier

Codex 桶虽然独立，但内部按模型分级，**每个 Tier 有自己的小桶**：

```
Codex 桶内部结构：

  ┌──────────────────────────────────────────┐
  │ Tier 1: 轻量模型（基本用不完）            │
  │                                          │
  │   - gpt-5.4-mini                         │
  │   - gpt-5.5                              │
  │   - codex-auto-review                    │
  │                                          │
  │   配额：5h 约 300+ 条，7d 宽松            │
  │   用途：日常对话、批量任务                 │
  └──────────────────────────────────────────┘

  ┌──────────────────────────────────────────┐
  │ Tier 2: 标准模型（中等配额）              │
  │                                          │
  │   - gpt-5.4                              │
  │   - gpt-5.6-sol / terra / luna           │
  │                                          │
  │   配额：5h 约 100 条                      │
  │   用途：复杂任务                          │
  └──────────────────────────────────────────┘

  ┌──────────────────────────────────────────┐
  │ Tier 3: 重型模型（最先耗尽）              │
  │                                          │
  │   - gpt-5.6-high                         │
  │   - gpt-5.6-medium                       │
  │   - o1-pro                               │
  │   - o3-pro                               │
  │                                          │
  │   配额：5h 约 20-40 条                    │
  │   用途：复杂推理                          │
  └──────────────────────────────────────────┘
```

**观察现象的解释**：

| 现象 | 原因 |
|------|------|
| 网页说满了 + Tier 1 还能调 | 桶 1 满，桶 2 Tier 1 没满 |
| Tier 1 还能调，Tier 3 调不通 | Tier 3 的小桶先满了 |
| 重启后又能调 | 5h 滚动窗口，最早的消息滑出窗口 |
| 7d 后某些模型重新能用 | 7d 周配额重置 |

## 五、桶 3 和桶 4：图像与高级推理

这两个桶相对独立，简单提一下：

```
桶 3: 图像生成桶
═══════════════
  触发模型：gpt-image-2、gpt-image-2-2k、gpt-image-2-4k
  配额：Plus 每天约 50 张（具体看官方公告）
  触发表现：图像生成返回 rate_limit_error
  
桶 4: 高级推理桶  
═══════════════
  触发模型：o1-pro、o3-pro、gpt-5.6-high
  配额：比 Tier 3 还紧，可能 5h 仅 10 条
  触发表现：返回 429 + "high reasoning quota exceeded"
```

**对中转站运营的意义**：这两个桶**很容易被一两个重度用户打满**——如果对外提供服务，建议把这两个桶对应的模型放最低优先级或限速配额。

## 六、codex2api 如何读取这些数据

codex2api 内部通过 `wham/usage` 接口获取完整状态：

```
请求：
  GET https://chatgpt.com/backend-api/wham/usage
  Authorization: Bearer <OAuth access_token>

响应（简化）：
{
  "rate_limit": {
    "primary": {                      ← 桶 1: 聊天
      "used_percent": 100,
      "reset_at": "2026-07-23T22:00:00Z",
      "window": "5h"
    },
    "secondary": {                    ← 桶 4: 高级推理
      "used_percent": 85,
      "window": "5h"
    },
    "codex_5h": {                     ← 桶 2 Tier 平均
      "used_percent": 32,
      "window": "5h"
    },
    "codex_7d": {                     ← 桶 2 周配额
      "used_percent": 45,
      "window": "7d"
    }
  },
  "credits_balance": "0",
  "credits_has_credits": false,
  "credits_unlimited": false,
  "plan_type": "plus"
}
```

codex2api 把这些字段映射到账号健康分：

```go
// auth/store.go (伪代码)
func (a *Account) UpdateUsage(resp WhamUsageResponse) {
    a.UsagePercent5h = resp.RateLimit.Codex5h.UsedPercent
    a.UsagePercent7d = resp.RateLimit.Codex7d.UsedPercent
    a.SubscriptionExpiresAt = parseDate(resp.SubscriptionActiveUntil)

    // 健康分计算
    a.HealthTier = computeHealthTier(a.UsagePercent5h, a.UsagePercent7d)
}

func computeHealthTier(usage5h, usage7d int) string {
    switch {
    case usage5h >= 100:
        return "banned"           // 5h 满了 → 跳过
    case usage5h >= 80:
        return "risky"            // 5h 接近满 → 谨慎用
    case usage7d >= 80:
        return "warm"             // 7d 接近满 → 备用
    default:
        return "healthy"          // 完全健康
    }
}
```

## 七、调度器如何利用桶状态

调度器根据这些桶状态做选择：

```
请求 → 调度器
         ↓
    排除 health_tier == "banned" 的账号（5h 满了的）
         ↓
    优先用 health_tier == "healthy" 的账号
         ↓
    对于 Tier 3 模型，额外检查 secondary 桶
         ↓
    加权随机（healthy > warm > risky）
```

所以即使 Plus 用户的聊天桶被打满，**codex2api 仍然能找到可用的账号和模型**——只要对应账号的 Codex 桶或对应模型 Tier 还有余量。

## 八、运营建议：怎么用好这个机制

### 1. 模型 Tier 与渠道优先级对照

```
new-api 渠道配置建议（多账号场景）：

  Channel 5 (codex2api-pro):
    - 优先级 = 10（最低，兜底）
    - 模型映射：
        gpt-5.4-mini, gpt-5.5        ← Tier 1，最稳
        gpt-5.4, gpt-5.6-*           ← Tier 2
        故意不映射 o1-pro 等重型      ← 留给用户直连
```

### 2. 重型模型用独立账号池

如果你有多个 ChatGPT 账号，**用专门的账号跑 Tier 3 重型模型**：

```
账号 A、B、C → 跑 gpt-5.4-mini/gpt-5.5（Tier 1）
账号 D、E   → 跑 gpt-5.6-high（Tier 3，避免被其他调用挤爆）
```

这样 Tier 3 的桶打满不影响 Tier 1 的日常使用。

### 3. 看 wham 数据决策何时扩容

监控脚本应该区分两类信号：

```bash
# 每小时检查
QUOTA_5H=$(curl ... wham/usage | jq .rate_limit.codex_5h.used_percent)
QUOTA_7D=$(curl ... wham/usage | jq .rate_limit.codex_7d.used_percent)
QUOTA_CHAT=$(curl ... wham/usage | jq .rate_limit.primary.used_percent)

# 注意：是 Codex 桶的数据，不是聊天桶！
if [ "$QUOTA_5H" -ge 80 ]; then
    echo "⚠️  Codex 5h 桶 80%，建议加账号"
fi
if [ "$QUOTA_7D" -ge 80 ]; then
    echo "⚠️  Codex 7d 桶 80%，本周容量快耗尽"
fi

# 聊天桶满了不用慌：
if [ "$QUOTA_CHAT" -ge 100 ]; then
    echo "💡  聊天桶 100%（不影响 codex 调用，无需处理）"
fi
```

### 4. 套餐升级的判断标准

不要看聊天桶——它对中转站无意义。判断该升级 Pro（$200/月）还是 Plus（$20/月）：

| 你的使用模式 | 推荐套餐 |
|------------|---------|
| 主要是 Tier 1 调用，轻量任务 | Plus（$20）就够 |
| 重度 Tier 3（o1-pro 等） | Pro（$200） |
| 用作团队共享渠道（10+ 人） | 每个成员自购 Pro，账号入池 |
| 商业转售 | 不推荐任何方案（合规风险） |

## 九、Plus vs Pro 的真实差别

| 维度 | Plus ($20/月) | Pro ($200/月) |
|------|---------------|---------------|
| 聊天桶 5h | 约 80 条 GPT-5 | 约 400 条 GPT-5 |
| Codex 桶 5h | 约 300 条轻量 | 约 1500 条轻量 |
| Codex 桶 Tier 3 | 5h 约 20-40 条 | 5h 约 100-200 条 |
| 高级推理桶 | 有但很紧 | 宽松 |
| 图像生成 | 约 50/天 | 约 500/天 |
| Codex 配额独立 | ✅ 是 | ✅ 是（更大） |

**注意**：Plus 和 Pro 的 Codex 桶**也是独立的**——Pro 用户有更大的 Codex 配额，但仍然是单独的计数器。

## 十、一句话总结

> **"Plus 额度用光"是个伪命题**。技术上是 4 个独立桶 + Codex 桶内 3 个 Tier 子桶 = **至少 12 个独立计数器**。你看到的"网页满了还能调"，是因为聊天桶和 Codex 桶是两个计数器；"轻量模型还能调但重型调不通"，是因为 Tier 1 和 Tier 3 是两个子桶。**理解这一点，才能设计出真正不被打爆的账号池**。

