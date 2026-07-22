---
title: "AI 中转站落地实践（四）：多渠道负载均衡与故障转移"
date: 2026-07-22
description: "系列第 4 篇：深入 new-api 渠道管理，按权重分配请求、自动故障转移、限速保护、模型-渠道映射表 abilities 的 SQL 调优，以及如何在多上游之间做智能路由。"
tags: [AI 中转站, new-api, 渠道管理, 负载均衡, 故障转移, SQLite]
draft: false
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · 03 网络打通 · **04 渠道配置** · 05 客户端使用 · 06 运维监控 · 07 合规与安全

上一篇把网络打通了，国内访问稳定了。这一篇进入**运营层面**最核心的话题：**多渠道怎么协调，怎么避免单点故障，怎么控制成本**。

## 为什么需要多渠道路由？

你已经有了 4 个上游服务，但只用其中一个，等于把所有鸡蛋放一个篮子里。

### 单渠道的风险

| 上游 | 风险 |
|------|------|
| **OpenAI API** | 余额耗尽 / 区域限流 / 账号风控 |
| **Anthropic API** | 余额耗尽 / TPM 限速 |
| **kiro-rs** | Kiro refresh token 失效 |
| **WindsurfAPI** | Windsurf 账号封禁 / 套餐过期 |

**只要一个挂了，整个中转站就停了**。

### 多渠道的目标

| 目标 | 含义 |
|------|------|
| **成本最优** | 贵的渠道（API）和便宜的渠道（Kiro）混用 |
| **容量扩展** | 一个渠道 TPM 不够，多个叠加 |
| **故障转移** | 一个挂了自动切下一个 |
| **灰度切换** | 验证新渠道不影响用户 |

## new-api 的路由模型

new-api 用 **3 张表** 控制渠道路由：

```
┌────────────────────────────────────────────────┐
│  channels（渠道表）                              │
│   - 每个上游 = 一条记录                          │
│   - 包含 type / base_url / api_key / status     │
└──────────────┬─────────────────────────────────┘
               │
               │ channel_id
               ▼
┌────────────────────────────────────────────────┐
│  abilities（能力授权表）                          │
│   - (group, model) → channel 的映射             │
│   - 控制"哪个用户组能用哪个模型通过哪个渠道"     │
└──────────────┬─────────────────────────────────┘
               │
               │ group
               ▼
┌────────────────────────────────────────────────┐
│  users / tokens（用户授权表）                     │
│   - user 属于某个 group                          │
│   - token 可以限制模型 / IP / 余额              │
└────────────────────────────────────────────────┘
```

### 一次请求的路由过程

```
1. 用户用 token 请求 claude-sonnet-4-5-20250929
   ↓
2. 验证 token → 找到 user_id → 找到 group (default)
   ↓
3. 查 abilities 表：
   SELECT * FROM abilities
   WHERE "group" = 'default'
     AND model = 'claude-sonnet-4-5-20250929'
     AND enabled = 1
   → 得到多个可用的 channel_id
   ↓
4. 在可用 channels 中按权重 / 优先级选一个
   ↓
5. 转发到选中的 channel
   ↓
6. 失败则按顺序尝试其他可用 channels
```

## 实战：搭建多渠道体系

### Step 1：在 new-api 中添加多个 OpenAI 渠道

假设你有 3 个 OpenAI API Key，可以把它们都加到 new-api，每个都是独立的渠道。

```sql
-- 渠道 1：主力 OpenAI 账号
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight) VALUES
  (0, 'openai-primary', 'https://api.openai.com', 'sk-primary-key', 'gpt-4o,gpt-4o-mini,gpt-3.5-turbo', 'default', 1, 10);

-- 渠道 2：备用 OpenAI 账号
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight) VALUES
  (0, 'openai-backup-1', 'https://api.openai.com', 'sk-backup-key-1', 'gpt-4o,gpt-4o-mini', 'default', 1, 5);

-- 渠道 3：低优先级备用
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight) VALUES
  (0, 'openai-backup-2', 'https://api.openai.com', 'sk-backup-key-2', 'gpt-4o-mini', 'default', 1, 1);
```

**关键字段**：

- `weight`：权重，数字越大分配的请求越多
- `priority`：优先级，数字越小越优先
- `status`：1 = 启用，2 = 禁用
- `auto_ban`：1 = 连续失败自动禁用（强烈建议开启）

### Step 2：添加 Anthropic 渠道

```sql
-- 渠道 4：主力 Anthropic
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight) VALUES
  (14, 'anthropic-primary', 'https://api.anthropic.com', 'sk-ant-primary', 'claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001', 'default', 1, 10);

-- 渠道 5：备用 Anthropic
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight) VALUES
  (14, 'anthropic-backup', 'https://api.anthropic.com', 'sk-ant-backup', 'claude-sonnet-4-5-20250929', 'default', 1, 5);
```

### Step 3：添加 kiro-rs 和 WindsurfAPI（便宜渠道）

```sql
-- 渠道 6：kiro-rs（AWS Kiro 套餐，零 token 成本）
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight) VALUES
  (14, 'kiro', 'http://kiro-rs:8990', 'sk-kiro-rs-default-key-2026', 'claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001', 'default', 1, 3);

-- 渠道 7：WindsurfAPI（Windsurf Free 套餐）
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight) VALUES
  (0, 'windsurf', 'http://windsurf-api:3003/v1', 'sk-windsurf-default-key-2026', 'gpt-4o,claude-sonnet-4-5-20250929', 'default', 1, 2);
```

### Step 4：配置 abilities（模型-渠道授权）

把模型映射到 channels。**这是最关键的一步**。

```sql
-- 给 gpt-4o 分配多个渠道
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('default', 'gpt-4o', 1, 1, 0, 10),    -- openai-primary
  ('default', 'gpt-4o', 2, 1, 1, 5),     -- openai-backup-1
  ('default', 'gpt-4o', 7, 1, 2, 2);     -- windsurf（最低优先级）

-- 给 claude-sonnet-4-5 分配多个渠道
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('default', 'claude-sonnet-4-5-20250929', 4, 1, 0, 10),   -- anthropic-primary
  ('default', 'claude-sonnet-4-5-20250929', 5, 1, 1, 5),    -- anthropic-backup
  ('default', 'claude-sonnet-4-5-20250929', 6, 1, 2, 3),    -- kiro-rs（便宜渠道）
  ('default', 'claude-sonnet-4-5-20250929', 7, 1, 3, 1);    -- windsurf（兜底）
```

字段说明：

- `priority`：越小越优先（0 最高，3 最低）
- `weight`：同优先级内的权重分布

### Step 5：测试故障转移

手动禁用主渠道，看请求是否自动切到备用：

```sql
-- 临时禁用 openai-primary
UPDATE channels SET status = 2 WHERE name = 'openai-primary';

-- 测试请求（应该走 backup）
curl -X POST https://api.your-domain.xyz/v1/chat/completions \
  -H "Authorization: Bearer sk-user-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "test"}]}'

-- 恢复
UPDATE channels SET status = 1 WHERE name = 'openai-primary';
```

## 限速与配额

new-api 提供多级限速保护。

### 1. 用户级别限速

```sql
-- 给某个用户设置额度限制（单位：美元等值）
UPDATE users SET quota = 10 WHERE username = 'dev-张三';

-- 设置无限额度（不推荐）
UPDATE users SET quota = 0 WHERE username = 'dev-zhangsan';
```

### 2. Token 级别限速

```sql
-- 给某个 Token 设置剩余额度
UPDATE tokens SET remain_quota = 5 WHERE name = 'team-shared-token';

-- 给 Token 设置无限额度
UPDATE tokens SET unlimited_quota = 1 WHERE name = 'team-shared-token';

-- Token 只允许特定模型
UPDATE tokens SET model_limits_enabled = 1, 
                 model_limits = 'gpt-4o-mini,claude-haiku-4-5-20251001' 
WHERE name = 'restricted-token';

-- Token 只允许特定 IP
UPDATE tokens SET allow_ips = '192.168.1.0/24,10.0.0.5' 
WHERE name = 'office-token';
```

### 3. 渠道级别限速（保护上游）

防止某个渠道被刷爆：

```sql
-- 给 openai-primary 设置优先级调低
UPDATE channels SET priority = 10 WHERE name = 'openai-primary';

-- 禁用某个渠道（手动）
UPDATE channels SET status = 2 WHERE name = 'openai-primary';

-- 渠道连续失败自动禁用（auto_ban）
UPDATE channels SET auto_ban = 1 WHERE name = 'openai-primary';
```

`auto_ban = 1` 时，new-api 检测到连续失败会自动禁用渠道，避免上游账号被封。

## 智能路由：成本优化策略

### 策略 1：便宜渠道优先

```sql
-- 让 kiro-rs（免费）优先于 Anthropic API（按量付费）
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('default', 'claude-sonnet-4-5-20250929', 6, 1, 0, 10),  -- kiro-rs 优先
  ('default', 'claude-sonnet-4-5-20250929', 4, 1, 1, 1);   -- Anthropic 兜底
```

**效果**：90% 请求走 kiro-rs（零成本），10% 走 Anthropic（兜底）。

### 策略 2：按模型分层

```sql
-- 高价值模型走最稳的渠道
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  -- Claude Opus（最强）：只走 Anthropic 官方
  ('default', 'claude-opus-4-5-20251101', 4, 1, 0, 10),
  
  -- Claude Sonnet（主力）：多渠道混合
  ('default', 'claude-sonnet-4-5-20250929', 6, 1, 0, 5),   -- kiro
  ('default', 'claude-sonnet-4-5-20250929', 4, 1, 1, 3),   -- anthropic
  ('default', 'claude-sonnet-4-5-20250929', 7, 1, 2, 2),   -- windsurf
  
  -- Haiku（轻量）：最便宜的优先
  ('default', 'claude-haiku-4-5-20251001', 7, 1, 0, 5),     -- windsurf（Free）
  ('default', 'claude-haiku-4-5-20251001', 6, 1, 1, 3);     -- kiro
```

### 策略 3：按用户组分层

```sql
-- VIP 用户组：只走最稳的 Anthropic 官方
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('vip', 'claude-sonnet-4-5-20250929', 4, 1, 0, 10);

-- 默认用户组：便宜渠道优先
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('default', 'claude-sonnet-4-5-20250929', 6, 1, 0, 5);

-- 给 VIP 用户升级分组
UPDATE users SET "group" = 'vip' WHERE username = 'dev-boss';
```

## 监控路由效果

### 看每个渠道的实时状态

new-api Web UI → 渠道列表，会显示：

```
渠道名称         状态    优先级  权重  响应时间  测试时间
openai-primary    ✅ 启用   0      10    230ms     5分钟前
openai-backup-1   ✅ 启用   1      5     280ms     2分钟前
anthropic-primary ✅ 启用   0      10    180ms     1分钟前
kiro-rs          ⚠️ 禁用   2      3     -         -
```

绿色勾表示启用，红色叉表示禁用或失败。

### SQL 查询：每个渠道的实际使用情况

```sql
-- 各渠道的请求数和成功率（最近 7 天）
SELECT 
  c.name AS channel_name,
  COUNT(*) AS total_requests,
  SUM(CASE WHEN l.status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success_count,
  ROUND(100.0 * SUM(CASE WHEN l.status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) / COUNT(*), 2) AS success_rate_pct,
  AVG(l.response_time_ms) AS avg_response_ms
FROM logs l
JOIN channels c ON l.channel_id = c.id
WHERE l.created_at > datetime('now', '-7 days')
GROUP BY c.id
ORDER BY total_requests DESC;
```

### SQL 查询：自动转移次数

```sql
-- 渠道被自动禁用的频率
SELECT 
  name,
  banned_at,
  banned_reason
FROM channels
WHERE status = 2
ORDER BY banned_at DESC;
```

## 实战：完整的渠道配置示例

下面是一套"个人 + 小团队"的最佳实践配置：

```sql
-- === 渠道 ===
-- OpenAI（主力）
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight, priority, auto_ban) VALUES
  (0, 'openai', 'https://api.openai.com', 'sk-your-openai-key', 'gpt-4o,gpt-4o-mini,gpt-3.5-turbo', 'default', 1, 10, 0, 1);

-- Anthropic（主力）
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight, priority, auto_ban) VALUES
  (14, 'anthropic', 'https://api.anthropic.com', 'sk-ant-your-key', 'claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001', 'default', 1, 10, 0, 1);

-- Kiro（免费备选）
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight, priority, auto_ban) VALUES
  (14, 'kiro', 'http://kiro-rs:8990', 'sk-kiro-rs-default-key-2026', 'claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001', 'default', 1, 5, 1, 0);

-- Windsurf（免费备选）
INSERT INTO channels (type, name, base_url, "key", models, "group", status, weight, priority, auto_ban) VALUES
  (0, 'windsurf', 'http://windsurf-api:3003/v1', 'sk-windsurf-default-key-2026', 'gpt-4o,claude-sonnet-4-5-20250929', 'default', 1, 3, 2, 0);

-- === 能力映射 ===
-- GPT-4o
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('default', 'gpt-4o', 1, 1, 0, 10),    -- openai 主
  ('default', 'gpt-4o', 4, 1, 1, 3);     -- windsurf 备

-- GPT-4o-mini
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('default', 'gpt-4o-mini', 1, 1, 0, 5),
  ('default', 'gpt-4o-mini', 4, 1, 1, 5);    -- 50/50

-- Claude Sonnet（最常用的模型，重点优化）
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('default', 'claude-sonnet-4-5-20250929', 3, 1, 0, 5),  -- kiro 免费优先
  ('default', 'claude-sonnet-4-5-20250929', 2, 1, 1, 3),  -- anthropic 付费
  ('default', 'claude-sonnet-4-5-20250929', 4, 1, 2, 2);  -- windsurf 兜底

-- Claude Haiku
INSERT OR REPLACE INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES
  ('default', 'claude-haiku-4-5-20251001', 4, 1, 0, 5),    -- windsurf 优先
  ('default', 'claude-haiku-4-5-20251001', 3, 1, 1, 3);    -- kiro 次之
```

**预期流量分配**：

```
请求 claude-sonnet-4-5-20250929：
  → 50% 走 kiro-rs（零成本）
  → 30% 走 Anthropic API
  → 20% 走 WindsurfAPI

如果 kiro-rs 挂了 → 自动切到 Anthropic
如果 Anthropic 限速 → 切到 Windsurf
如果全部挂了 → 用户看到错误（兜底不够时）
```

## 故障排查清单

### Q1: 渠道显示"已禁用"，但没主动禁

```sql
-- 看 banned_reason
SELECT name, status, banned_reason FROM channels WHERE status = 2;
```

通常 `auto_ban = 1` 触发：连续失败次数超过阈值。

**解决**：

```sql
-- 重置失败计数
UPDATE channels SET failure_count = 0 WHERE name = 'xxx';

-- 重新启用
UPDATE channels SET status = 1 WHERE name = 'xxx';
```

### Q2: 模型"找不到渠道"

```sql
-- 看 abilities 表里有没有这个模型
SELECT * FROM abilities WHERE model = 'claude-sonnet-4-5-20250929';
```

如果没有 INSERT 一条。

### Q3: 渠道 429（限速）

new-api 默认会把 429 视为"软失败"（不触发 auto_ban），会自动切下一个渠道。

但如果所有渠道都 429，用户会看到错误。**临时缓解**：调高权重，把便宜的渠道（kiro/windsurf）权重加大。

## 本篇总结

本篇把"多渠道运营"讲透了：

- ✅ **多渠道模型**：`channels` 表 + `abilities` 表的双层结构
- ✅ **负载均衡**：权重 + 优先级 + 自动分配
- ✅ **故障转移**：`auto_ban` + 优先级自动切换
- ✅ **限速保护**：用户 / Token / 渠道三级限速
- ✅ **成本优化**：便宜渠道优先，付费渠道兜底
- ✅ **完整 SQL 模板**：开箱即用的多渠道配置

下一篇《05 客户端使用》会讲**怎么把这些服务接入到 Claude Code / Cherry Studio / CC Switch 等客户端**，让团队成员用起来。

## 参考资料

- [new-api 文档](https://github.com/QuantumNous/new-api/)
- [SQLite 性能优化](https://www.sqlite.org/optoverview.html)
- [负载均衡策略对比](https://en.wikipedia.org/wiki/Load_balancing_(computing))

---
