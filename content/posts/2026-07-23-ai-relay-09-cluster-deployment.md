---
title: "AI 中转站落地实践（九）：100+ 人多机部署与精细化配额管理"
date: 2026-07-23
description: "系列第 9 篇：团队突破 100 人后，单机 new-api + SQLite 撑不住了。这一篇讲多机部署架构、Redis 共享会话与缓存、按部门/项目的配额隔离、用量计费报表，以及从单点到集群的平滑迁移路径。"
tags: [AI 中转站, 多机部署, Redis, 配额管理, 集群, 计费]
draft: false
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · 03 网络打通 · 04 渠道配置 · 05 客户端使用 · 06 运维监控 · 07 合规与安全 · 08 容量规划 · **09 集群化**

上一篇解决了 50 人 × 10 账号的分发问题。但当团队超过 100 人，你会遇到**单机和单数据库都扛不住**的新问题：

- **单机 new-api** 成为单点故障，挂了全员断供
- **SQLite** 在高并发写入（日志、用量统计）时锁表，接口变慢
- **渠道亲和性缓存**存在单机内存里，多机部署后会话漂移
- **配额管理**需要按部门/项目隔离，而不是全员共享一个大池子

这一篇给出从**单机 → 集群**的完整演进方案。

## 一、100 人 vs 50 人：质变在哪里

| 维度 | 50 人（单机够用） | 100+ 人（必须集群） |
|------|------------------|---------------------|
| 并发连接 | ~30 峰值 | ~80-120 峰值 |
| 日 token 量 | ~100 万 | ~300-500 万 |
| new-api 日志写入 | ~5000 条/天 | ~20000+ 条/天 |
| SQLite 锁冲突 | 偶发 | 频繁，接口 500ms+ |
| 可用性要求 | 挂 10 分钟可接受 | 挂 1 分钟就炸群 |
| 配额管理 | 全员共享 | 按部门/项目隔离 |

**关键转折点**：当 SQLite 的写锁开始拖慢 API 响应（>200ms），就必须换数据库；当单机宕机影响超过 10 分钟，就必须多机。

## 二、多机部署架构

### 整体拓扑

```
                    ┌──────────────┐
                    │  Cloudflare  │  ← 智能路由 + DDoS 防护
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Nginx LB    │  ← 负载均衡（轮询/最少连接）
                    │  :443        │
                    └──┬───┬───┬───┘
                       │   │   │
        ┌──────────────┘   │   └──────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│  new-api-01   │  │  new-api-02   │  │  new-api-03   │
│  :3000        │  │  :3000        │  │  :3000        │
│  (硅谷)        │  │  (硅谷)        │  │  (日本/香港)   │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
              ┌────────────▼────────────┐
              │   PostgreSQL (主)        │  ← 替代 SQLite
              │   :5432                 │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │   Redis (缓存+会话)      │  ← 共享亲和性/限流
              │   :6379                 │
              └─────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   kiro-rs 集群      CLIProxyAPI        WindsurfAPI
   (账号池 30+)      (OpenAI 聚合)      (备用渠道)
```

### 关键组件

#### 1. Nginx 负载均衡层

**作用**：
- 把客户端请求分散到多台 new-api
- 健康检查，自动剔除故障节点
- SSL 终止（可选，也可以让 Cloudflare 处理）

**配置示例**（`/etc/nginx/conf.d/new-api.conf`）：

```nginx
upstream new_api_backend {
    least_conn;  # 最少连接优先，比轮询更智能

    server 43.173.75.146:3000 max_fails=3 fail_timeout=30s;
    server 43.173.75.147:3000 max_fails=3 fail_timeout=30s;
    server 45.32.10.20:3000   max_fails=3 fail_timeout=30s backup;  # 备用节点

    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    location / {
        proxy_pass http://new_api_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 流式响应必须关闭缓冲
        proxy_buffering off;
        proxy_cache off;

        # 超时设置（AI 响应可能很慢）
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # 健康检查端点（不转发）
    location /health {
        access_log off;
        return 200 "healthy\n";
    }
}
```

**部署**：

```bash
# 在 Cloudflare 后面加一层 Nginx（也可以直接用 Cloudflare Load Balancing，但收费）
docker run -d --name nginx-lb \
  -p 443:443 \
  -v /etc/nginx/conf.d:/etc/nginx/conf.d:ro \
  -v /etc/nginx/ssl:/etc/nginx/ssl:ro \
  nginx:alpine
```

#### 2. PostgreSQL 替代 SQLite

**为什么必须换**：

SQLite 在并发写入时会**全库加锁**，100 人同时调用时，日志表（`logs`）和用量表（`quota_data`）的写入会互相阻塞，导致 API 响应延迟从 50ms 涨到 500ms+。

PostgreSQL 支持**行级锁**，并发写入性能高 10 倍以上。

**部署**：

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    container_name: new-api-postgres
    restart: always
    environment:
      POSTGRES_DB: newapi
      POSTGRES_USER: newapi
      POSTGRES_PASSWORD: ${DB_PASSWORD}  # 强密码
    volumes:
      - ./postgres-data:/var/lib/postgresql/data
    ports:
      - "5432:5432"  # 只允许内网访问，不要暴露公网
    networks:
      - ai-services

networks:
  ai-services:
    external: true
```

**new-api 配置切换**：

```yaml
# new-api 的环境变量
services:
  new-api:
    image: calciumion/new-api:latest
    environment:
      # 从 SQLite 切换到 PostgreSQL
      SQL_DSN: "postgresql://newapi:${DB_PASSWORD}@postgres:5432/newapi?sslmode=disable"
      # Redis 配置（下面会讲）
      REDIS_CONN_STRING: "redis://redis:6379"
      # 其他配置...
    depends_on:
      - postgres
      - redis
```

**数据迁移**（SQLite → PostgreSQL）：

```bash
# 1. 导出 SQLite 数据
sqlite3 /opt/ai-services/new-api/data/one-api.db .dump > backup.sql

# 2. 转换 SQL 语法（SQLite 和 PostgreSQL 有差异）
# 可以用 pgloader 工具自动迁移
docker run --rm -v $(pwd):/data dimitri/pgloader:latest \
  pgloader sqlite:///data/one-api.db \
  postgresql://newapi:password@postgres:5432/newapi

# 3. 验证数据
docker exec new-api-postgres psql -U newapi -c "SELECT COUNT(*) FROM channels;"
docker exec new-api-postgres psql -U newapi -c "SELECT COUNT(*) FROM users;"
```

#### 3. Redis 共享缓存与会话

**解决的问题**：

1. **渠道亲和性缓存**：单机时存在内存里，多机部署后，用户第一次请求到 new-api-01，第二次可能到 new-api-02，亲和性失效
2. **限流计数**：100 人的 RPM 统计需要全局视图，不能每台机器各算各的
3. **会话缓存**：用户登录态、令牌验证结果缓存

**部署**：

```yaml
services:
  redis:
    image: redis:7-alpine
    container_name: new-api-redis
    restart: always
    command: redis-server --requirepass ${REDIS_PASSWORD} --maxmemory 2gb --maxmemory-policy allkeys-lru
    volumes:
      - ./redis-data:/data
    ports:
      - "6379:6379"  # 只允许内网
    networks:
      - ai-services
```

**new-api 启用 Redis**：

```yaml
environment:
  REDIS_CONN_STRING: "redis://:${REDIS_PASSWORD}@redis:6379"
  # 启用 Redis 后，以下功能自动切换为共享模式：
  # - 渠道亲和性缓存（Channel Affinity）
  # - 用户限流计数
  # - 令牌验证缓存
  # - 会话存储
```

**验证**：

```bash
# 测试 Redis 连接
docker exec new-api-redis redis-cli -a ${REDIS_PASSWORD} PING
# 应返回 PONG

# 查看缓存键
docker exec new-api-redis redis-cli -a ${REDIS_PASSWORD} KEYS "new-api:*"
# 应看到 channel_affinity、rate_limit 等前缀
```

## 三、精细化配额管理

100 人团队通常按**部门**或**项目**划分，需要独立的配额池。

### 1. 按部门分组（Group）

new-api 的 `groups` 表支持多用户组，每组可以：
- 绑定不同的渠道（比如研发部用 Kiro，产品部用 OpenAI）
- 设置独立的倍率（比如管理层 1.0，实习生 0.5）
- 独立配额限制

**配置示例**（SQL）：

```sql
-- 创建部门分组
INSERT INTO groups (name, ratio, created_time) VALUES
  ('engineering', 1.0, UNIX_TIMESTAMP()),
  ('product', 1.0, UNIX_TIMESTAMP()),
  ('intern', 0.5, UNIX_TIMESTAMP());

-- 给用户分配分组
UPDATE users SET group = 'engineering' WHERE username LIKE 'dev-%';
UPDATE users SET group = 'product' WHERE username LIKE 'pm-%';
UPDATE users SET group = 'intern' WHERE username LIKE 'intern-%';

-- 给分组绑定渠道（abilities 表）
-- 研发部可以用所有渠道
INSERT INTO abilities (group_name, model, channel_id, enabled, priority, weight)
SELECT 'engineering', model, channel_id, 1, priority, weight
FROM abilities WHERE group_name = 'default';

-- 实习生只能用便宜的渠道（Kiro）
INSERT INTO abilities (group_name, model, channel_id, enabled, priority, weight)
SELECT 'intern', model, channel_id, 1, priority, weight
FROM abilities WHERE group_name = 'default' AND channel_id IN (
  SELECT id FROM channels WHERE type = 'kiro'
);
```

### 2. 按项目令牌（Token）配额

每个项目申请一个独立的 API Token，设置：
- 每日/每月 token 上限
- 过期时间
- IP 白名单

**控制台操作**：

```
new-api 控制台 → 令牌管理 → 新增令牌
  ├─ 名称：proj-recommendation-engine
  ├─ 分组：engineering
  ├─ 过期时间：2026-12-31
  ├─ 额度：1000000 (100 万 token)
  └─ IP 限制：10.0.1.0/24 (只允许内网)
```

**程序化创建**（API）：

```bash
curl -X POST http://localhost:3000/api/token/ \
  -H "Authorization: Bearer sk-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "proj-recommendation-engine",
    "group": "engineering",
    "expired_time": 1735689600,
    "remain_quota": 1000000,
    "unlimited_quota": false
  }'
```

### 3. 用量计费报表

**按部门统计**（SQL）：

```sql
-- 本月各部门 token 消耗
SELECT
  u.group AS department,
  COUNT(DISTINCT l.user_id) AS active_users,
  SUM(l.prompt_tokens + l.completion_tokens) AS total_tokens,
  SUM(l.quota) AS total_quota,
  ROUND(SUM(l.quota) / 500000.0, 2) AS cost_usd  -- 假设 $1 = 50万 quota
FROM logs l
JOIN users u ON l.user_id = u.id
WHERE l.created_at >= UNIX_TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-01'))
GROUP BY u.group
ORDER BY total_tokens DESC;
```

**按项目统计**：

```sql
-- 本月各项目（按令牌）消耗排行
SELECT
  t.name AS project,
  t.group AS department,
  COUNT(l.id) AS requests,
  SUM(l.prompt_tokens + l.completion_tokens) AS total_tokens,
  SUM(l.quota) AS total_quota
FROM logs l
JOIN tokens t ON l.token_id = t.id
WHERE l.created_at >= UNIX_TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-01'))
GROUP BY t.id
ORDER BY total_quota DESC
LIMIT 20;
```

**自动生成日报**（Python 脚本）：

```python
#!/usr/bin/env python3
# /opt/ai-services/scripts/daily-report.py

import psycopg2
import smtplib
from email.mime.text import MIMEText
from datetime import datetime, timedelta

conn = psycopg2.connect("postgresql://newapi:password@postgres:5432/newapi")
cur = conn.cursor()

# 昨天的数据
yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')

cur.execute("""
SELECT
  u.group,
  COUNT(DISTINCT l.user_id),
  SUM(l.prompt_tokens + l.completion_tokens),
  SUM(l.quota)
FROM logs l
JOIN users u ON l.user_id = u.id
WHERE DATE(TO_TIMESTAMP(l.created_at)) = %s
GROUP BY u.group
""", (yesterday,))

report = f"AI 中转站日报 - {yesterday}\n\n"
report += f"{'部门':<15} {'活跃用户':<10} {'Token消耗':<15} {'配额消耗':<10}\n"
report += "-" * 60 + "\n"

for row in cur.fetchall():
    report += f"{row[0]:<15} {row[1]:<10} {row[2]:<15} {row[3]:<10}\n"

# 发送邮件
msg = MIMEText(report, 'plain', 'utf-8')
msg['Subject'] = f'AI 中转站日报 {yesterday}'
msg['From'] = 'noreply@yourcompany.com'
msg['To'] = 'admin@yourcompany.com'

smtp = smtplib.SMTP('smtp.exmail.qq.com', 587)
smtp.starttls()
smtp.login('noreply@yourcompany.com', 'password')
smtp.send_message(msg)
smtp.quit()

print(report)
```

**定时任务**：

```bash
# 每天早上 9 点发送昨日报表
0 9 * * * /usr/bin/python3 /opt/ai-services/scripts/daily-report.py
```

## 四、从单机到集群的平滑迁移

不能停机迁移，需要**灰度切换**。

### 步骤 1：准备新环境（不影响现有服务）

```bash
# 在新服务器上部署 PostgreSQL + Redis
ssh new-server
docker compose up -d postgres redis

# 验证新数据库可连接
psql -h new-server -U newapi -d newapi -c "SELECT 1"
```

### 步骤 2：数据迁移（读旧写新）

```bash
# 在旧服务器上，用 pgloader 迁移数据
pgloader sqlite:///opt/ai-services/new-api/data/one-api.db \
  postgresql://newapi:password@new-server:5432/newapi

# 验证数据完整性
psql -h new-server -U newapi -c "SELECT COUNT(*) FROM channels;"
sqlite3 /opt/ai-services/new-api/data/one-api.db "SELECT COUNT(*) FROM channels;"
# 数字应该一致
```

### 步骤 3：部署第二台 new-api（连接新数据库）

```yaml
# new-server 上的 docker-compose.yml
services:
  new-api:
    image: calciumion/new-api:latest
    environment:
      SQL_DSN: "postgresql://newapi:password@postgres:5432/newapi"
      REDIS_CONN_STRING: "redis://:password@redis:6379"
    ports:
      - "3000:3000"
```

### 步骤 4：流量灰度切换

```nginx
# Nginx 配置：先切 10% 流量到新节点
upstream new_api_backend {
    server old-server:3000 weight=9;   # 90% 流量
    server new-server:3000 weight=1;   # 10% 流量
}
```

观察 24 小时，确认新节点稳定后：

```nginx
# 切换到 50/50
upstream new_api_backend {
    server old-server:3000 weight=1;
    server new-server:3000 weight=1;
}
```

再观察 24 小时，最后：

```nginx
# 全部切换到新节点
upstream new_api_backend {
    server new-server:3000;
    server old-server:3000 backup;  # 保留旧节点作为备用
}
```

### 步骤 5：下线旧 SQLite

确认新环境稳定运行 1 周后：

```bash
# 备份旧数据库
tar -czf one-api-backup-$(date +%Y%m%d).tar.gz /opt/ai-services/new-api/data/

# 停止旧 new-api 容器
docker stop new-api-old

# 保留 1 个月后再删除备份
```

## 五、高可用与容灾

### 1. 数据库主从复制

```yaml
# PostgreSQL 主从配置
services:
  postgres-primary:
    image: postgres:16-alpine
    environment:
      POSTGRES_REPLICATION_MODE: master
      POSTGRES_REPLICATION_USER: replicator
      POSTGRES_REPLICATION_PASSWORD: ${REPL_PASSWORD}

  postgres-replica:
    image: postgres:16-alpine
    environment:
      POSTGRES_REPLICATION_MODE: slave
      POSTGRES_MASTER_HOST: postgres-primary
      POSTGRES_REPLICATION_USER: replicator
      POSTGRES_REPLICATION_PASSWORD: ${REPL_PASSWORD}
```

**故障切换**：主库挂了，手动提升从库为主库（或用 Patroni 自动切换）。

### 2. Redis 哨兵模式

```yaml
services:
  redis-master:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}

  redis-replica:
    image: redis:7-alpine
    command: redis-server --replicaof redis-master 6379 --requirepass ${REDIS_PASSWORD}

  redis-sentinel:
    image: redis:7-alpine
    command: redis-sentinel /etc/sentinel.conf
    volumes:
      - ./sentinel.conf:/etc/sentinel.conf
```

**new-api 连接哨兵**：

```yaml
environment:
  REDIS_CONN_STRING: "redis+sentinel://:password@sentinel1:26379,sentinel2:26379/mymaster"
```

### 3. 定期备份

```bash
#!/bin/bash
# /opt/ai-services/scripts/backup.sh

DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/opt/backups"

# 备份 PostgreSQL
docker exec new-api-postgres pg_dump -U newapi newapi | gzip > $BACKUP_DIR/newapi-$DATE.sql.gz

# 备份 Redis
docker exec new-api-redis redis-cli -a ${REDIS_PASSWORD} --rdb /data/dump-$DATE.rdb

# 保留最近 30 天
find $BACKUP_DIR -name "*.sql.gz" -mtime +30 -delete

# 上传到对象存储（可选）
# aws s3 cp $BACKUP_DIR/newapi-$DATE.sql.gz s3://your-bucket/backups/
```

**定时任务**：

```bash
# 每天凌晨 2 点备份
0 2 * * * /opt/ai-services/scripts/backup.sh
```

## 六、成本估算

100 人团队的月度成本（美元）：

| 项目 | 配置 | 月成本 |
|------|------|-------:|
| 服务器 ×3 | 4C8G（硅谷 ×2 + 日本 ×1） | $60 × 3 = $180 |
| PostgreSQL | 独立 VPS 2C4G | $40 |
| Redis | 独立 VPS 1C2G | $20 |
| Cloudflare Pro | 负载均衡 + 加速 | $20 |
| Kiro 账号 ×30 | $20/账号 | $600 |
| OpenAI API | 备用渠道 | $200 |
| 域名 + SSL | 年费分摊 | $5 |
| **总计** | | **~$1065/月** |

**人均成本**：$10.65/人/月，比直接买 Claude Pro（$20/人）便宜 47%。

## 小结

100+ 人团队的核心是**消除单点、精细隔离、可观测**。

| 层级 | 关键技术 | 解决的问题 |
|------|---------|-----------|
| **接入层** | Nginx LB + Cloudflare | 负载均衡、故障转移 |
| **应用层** | new-api ×3（多机） | 消除单点、水平扩展 |
| **数据层** | PostgreSQL 主从 + Redis 哨兵 | 高并发写入、共享缓存 |
| **配额层** | 分组 + 令牌 + 报表 | 按部门/项目隔离计费 |
| **容灾层** | 主从复制 + 定期备份 | 数据不丢、快速恢复 |

**迁移路径**：单机 SQLite → 单机 PostgreSQL → 多机 + Redis → 主从 + 哨兵，每一步都可以灰度切换，不停机。

**下一步**：如果团队超过 500 人，需要考虑 Kubernetes 编排、服务网格（Istio）、多地域部署（欧美亚三节点），以及接入企业级 SSO（Okta/飞书）。这些属于平台工程范畴，超出本系列范围。

