---
title: "AI 中转站落地实践（八）：账号池容量规划与多人稳定使用"
date: 2026-07-22
description: "系列第 8 篇：账号数与用户数如何匹配？50 人共用 10 个 Kiro 账号怎么分发？从并发模型、配额计算、new-api 亲和性/权重/优先级机制，到错峰调度和降级链设计，给出多人稳定使用的完整方案。"
tags: [AI 中转站, 账号池, 容量规划, 负载均衡, new-api, 亲和性]
draft: false
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · 03 网络打通 · 04 渠道配置 · 05 客户端使用 · 06 运维监控 · 07 合规与安全 · **08 容量规划**

服务跑起来了，客户端也接好了。但当你把团队从 5 人扩到 20 人、50 人时，**最先撞墙的不是服务器，而是上游账号**。

这一篇解决一个核心问题：**账号数和用户数怎么匹配，才能让每个人都稳定用上模型？**

## 一个真实场景

假设你有：

- **10 个 Kiro 账号**（在 kiro-rs 中组成账号池）
- **50 个团队成员**（Claude Code / Continue / Cursor 用户）

这意味着平均 **1 个账号要扛 5 个人**。

问题：
- 高峰期 30 人同时请求，会不会把所有账号打满？
- 某个账号配额快用完时，怎么自动把流量切到别的账号？
- 某个用户一直在同一个会话，能不能固定路由到同一个账号（命中 prompt 缓存）？

## 核心矛盾：账号级限速 × 用户级并发

先理解一个关键事实：**Kiro / Kimi / OpenAI 的限制是"账号级"的，不是"连接级"的**。

| 上游 | 常见限制 | 含义 |
|------|---------|------|
| Kiro | 每账号 60 RPM + 每日 token 配额 | 单账号 1 秒最多 1 个请求 |
| Kimi | 每 API Key 3 RPM / 100万 TPM | 单 Key 严格限频 |
| OpenAI | 按余额和 tier 分级 RPM | 高 tier 才高并发 |

**这意味着**：50 人同时请求 = 50 个并发连接，但 10 个账号每个只能扛 6 RPM 的话，**瓶颈在账号，不在你的服务器**。

## 容量估算：账号数 vs 用户数

### 计算模型

```
账号总容量 = 账号数 × 单账号RPM
用户需求 = 用户数 × 人均RPM（活跃时）
```

以 Kiro 为例（假设单账号 60 RPM）：

| 账号数 | 总容量 | 可支撑用户数（人均 10 RPM） |
|-------:|-------:|---------------------------:|
| 3 | 180 RPM | 18 人 |
| 10 | 600 RPM | 60 人 |
| 20 | 1200 RPM | 120 人 |

**经验公式**：`账号数 ≈ 用户数 ÷ 5`（活跃使用场景）

### 日配额维度

另一个约束是**每日 token 配额**：

```
单账号日配额 = 10 万 token（常见档）
10 账号 × 10 万 = 100 万 token/天
50 人 × 人均 2 万 token = 100 万 token/天
```

**刚好打平**。如果用户是重度 Claude Code 用户（人均 3-5 万），就需要更多账号或引导错峰。

## 分发策略：四层组合

光知道容量还不够，还得解决"怎么分"的问题。推荐**四层策略叠加**：

### 第 1 层：优先级分组（Priority）—— 降级兜底

new-api 的 `channels` 表有 `priority` 字段，数值越大优先级越高。

```
Kiro 池（10个渠道）  → priority = 100（主力）
Kimi k3             → priority = 50（备用 1）
OpenAI gpt-5.4-mini → priority = 10（备用 2）
```

**行为**：请求先打到 priority=100 的 Kiro 池，全部失败后才降级到 priority=50 的 Kimi，以此类推。

**配置**（SQL）：

```sql
-- 10 个 Kiro 账号统一设为最高优先级
UPDATE channels SET priority = 100 WHERE type = 'kiro';

-- Kimi 备用
UPDATE channels SET priority = 50 WHERE name = 'kimi';

-- OpenAI 兜底
UPDATE channels SET priority = 10 WHERE name = 'openai';
```

### 第 2 层：权重分配（Weight）—— 同优先级内分流

同优先级（比如 10 个 Kiro 账号）之间，用 `weight` 控制流量分配比例。

- 权重相同 = 均匀随机
- 权重 2:1 = 前者流量是后者两倍

**用途**：
- 新账号权重调高（快速磨合）
- 配额快用完的账号权重调低（保护）

**配置**：

```sql
-- 10 个账号初始均匀分配
UPDATE channels SET weight = 100 WHERE type = 'kiro';

-- 某个账号今天用量超 80%，降权
UPDATE channels SET weight = 20 WHERE id = 5;
```

### 第 3 层：渠道亲和性（Channel Affinity）—— 粘性路由

new-api 新版（2025 年后）内置了**渠道亲和性**功能：同一用户的会话，优先路由到上次成功的渠道。

**为什么需要**：
- Claude Code 一次会话会发多次连续请求
- 同一账号连续调用可命中 prompt 缓存，延迟更低
- 避免频繁换账号导致每次都冷启动

**开启方法**：

控制台 → 系统设置 → 通用 → **渠道亲和性（Channel Affinity）**

关键配置：

| 配置项 | 推荐值 | 说明 |
|--------|--------|------|
| `enabled` | true | 总开关 |
| `key_sources` | `context_string` (user_id) | 按用户 ID 粘性 |
| `ttl_seconds` | 3600 | 1 小时内保持同一渠道 |
| `switch_on_success` | true | 成功后更新记录 |

**后端逻辑**（`middleware/distributor.go:104`）：

```go
if preferredChannelID, found := service.GetPreferredChannelByAffinity(c, model, group); found {
    // 命中亲和缓存，直接用该渠道
    channel = preferred
} else {
    // 未命中，走正常权重选择
    channel, _ = service.CacheGetRandomSatisfiedChannel(...)
}
```

### 第 4 层：请求队列（客户端 + 网关配合）

new-api **本身没有队列机制**（超过容量直接 429），但可以通过以下方式实现"软队列"：

**方案 A：客户端退避重试**

所有主流客户端（Claude Code、Continue、CC Switch）收到 429 后都会自动指数退避重试。配合 new-api 的多渠道失败转移，实际效果约等于排队。

**方案 B：前置轻量网关**（可选）

在 new-api 前面加一个 Go/Python 网关，实现：

```
用户请求 → 网关队列 → 按每账号 0.5 QPS 限速放出 → new-api
```

超过队列容量的请求返回"排队中"而不是直接失败。

**代码示例**（Python + asyncio）：

```python
import asyncio
from collections import defaultdict

class AccountQueue:
    def __init__(self, account_ids, qps_per_account=0.5):
        self.queues = {aid: asyncio.Queue(maxsize=10) for aid in account_ids}
        self.qps = qps_per_account
        self.tasks = []

    async def worker(self, account_id):
        while True:
            request = await self.queues[account_id].get()
            await forward_to_newapi(request, account_id)
            await asyncio.sleep(1 / self.qps)

    async def submit(self, request, account_id):
        try:
            self.queues[account_id].put_nowait(request)
        except asyncio.QueueFull:
            return {"status": "queuing", "retry_after": 2}
```

对 50 人团队，通常**方案 A 就够了**——除非高峰期并发特别集中。

## 运营保障：监控与调度

### 1. 实时监控

扩展你的 `kiro-monitor` 脚本，增加配额维度：

```bash
#!/bin/bash
# 每日配额检查（UTC 0 点重置）

for account in kiro-01 kiro-02 ... kiro-10; do
    usage=$(sqlite3 kiro-rs.db "SELECT SUM(tokens) FROM usage WHERE account='$account' AND date=today")
    quota=100000
    percent=$((usage * 100 / quota))

    if [ $percent -gt 80 ]; then
        echo "⚠️  $account: $percent% used"
        # 自动降权
        sqlite3 new-api.db "UPDATE channels SET weight=20 WHERE name='$account'"
    fi
done
```

### 2. 错峰调度

账号配额重置时间错开（如果平台支持）：

- 账号 1-3：UTC 0 点重置
- 账号 4-6：UTC 8 点重置
- 账号 7-10：UTC 16 点重置

避免所有账号同时耗尽。

### 3. 失败自动隔离与恢复

kiro-rs 默认"连续 3 次失败自动禁用"，但**不会自动恢复**。建议：

```bash
# 每 10 分钟探活一次被禁用的账号
*/10 * * * * /opt/ai-services/scripts/kiro-health-check.sh
```

脚本内容：

```bash
#!/bin/bash
for disabled_account in $(curl http://localhost:8990/admin/accounts?status=disabled); do
    # 发送测试请求
    if curl -X POST http://localhost:8990/test -d "{\"account\":\"$disabled_account\"}" | grep -q "ok"; then
        # 恢复账号
        curl -X POST http://localhost:8990/admin/enable -d "{\"account\":\"$disabled_account\"}"
    fi
done
```

## 实际效果验证

配置完成后，用以下方式验证：

### 压测

```bash
# 模拟 50 人并发
for i in {1..50}; do
    curl -X POST http://localhost:3000/v1/chat/completions \
      -H "Authorization: Bearer sk-user-$i" \
      -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"test"}]}' &
done
wait
```

观察：
- 成功率 > 95%
- 429 比例 < 5%
- 平均延迟 < 3 秒

### 监控面板

new-api 控制台 → 日志 → 按渠道分组统计：

```
Kiro-01: 120 请求 / 成功率 98%
Kiro-02: 115 请求 / 成功率 97%
...
Kimi:    30 请求 / 成功率 100%（降级触发）
```

如果降级链频繁触发，说明 Kiro 池容量不够，需要加账号。

## 扩容决策树

遇到瓶颈时，按优先级扩容：

```
429 错误率高？
  ├─ 是 → 账号数 < 用户数 ÷ 5？
  │       ├─ 是 → 加账号（成本最低）
  │       └─ 否 → 检查是否有账号配额异常（个别账号拖后腿）
  │
  └─ 否 → 延迟高？
          ├─ 是 → 服务器 CPU/内存占用 > 80%？
          │       ├─ 是 → 升级服务器配置
          │       └─ 否 → 跨境网络问题，优化路由（见系列第 3 篇）
          └─ 否 → 当前配置已足够
```

## 小结

多人稳定使用的核心不是"堆服务器配置"，而是**账号池 + 智能路由**。

| 关键策略 | 实现方式 | 效果 |
|---------|---------|------|
| **优先级分组** | new-api `priority` 字段 | 自动降级兜底 |
| **权重分配** | new-api `weight` 字段 | 同优先级内分流 |
| **渠道亲和性** | new-api Channel Affinity | 粘性路由，命中缓存 |
| **客户端重试** | 客户端内置机制 | 软队列效果 |
| **配额监控** | 自定义脚本 | 自动降权/隔离 |

**经验公式**：

- 账号数 ≈ 用户数 ÷ 5（活跃场景）
- 日配额 = 用户数 × 人均 2 万 token
- 带宽 = 并发数 × 50 kbps（20 人约 1 Mbps）

先靠 new-api 原生机制跑起来，观察高峰 429 频率，再决定是否需要前置队列网关。


