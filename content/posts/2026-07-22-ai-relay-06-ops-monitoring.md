---
title: "AI 中转站落地实践（六）：运维监控与故障恢复"
date: 2026-07-22
description: "系列第 6 篇：自建 AI 中转站的日常运维全套——健康检查、用量统计、Token 自动刷新、异常告警、故障排查清单、备份与恢复脚本，让你的中转站稳定运行 7×24。"
tags: [AI 中转站, 运维监控, 健康检查, 用量统计, 告警, 备份恢复]
draft: true
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · 03 网络打通 · 04 渠道配置 · 05 客户端使用 · **06 运维监控** · 07 合规与安全

服务跑起来了，客户端也接好了。但**真正的考验是长期稳定运行**：

- 服务挂了怎么知道？
- 上游渠道余额用完怎么告警？
- kiro-rs 的 refresh token 失效怎么自动续期？
- 用户激增怎么扩容？
- 数据库坏了怎么恢复？

这一篇给出**一整套可落地的运维方案**。

## 一、健康检查：每 30 秒确认一次

健康检查分 3 个层级：

```
Layer 1: 容器存活        → Docker 自动重启
Layer 2: HTTP 端口响应  → 服务是否正常处理请求
Layer 3: 上游渠道可用性 → 真正的 AI API 是否能调通
```

### Layer 1：容器存活（Docker 已内置）

`docker-compose.yml` 里加了 `restart: always`，容器挂了会自动重启。

**验证**：

```bash
docker ps
# 4 个容器都应该在 Up 状态
```

### Layer 2：HTTP 端口响应（每 30 秒）

写一个 health-check 脚本：

```bash
#!/bin/bash
# /opt/ai-services/scripts/health-check.sh

SERVICES=(
  "new-api:3000:/"
  "cliproxyapi:8317:/v1/models"
  "kiro-rs:8990:/v1/models"
  "windsurf-api:3003:/health"
)

ALERT_EMAIL="you@example.com"  # 改成你的
FAILED=()

for svc in "${SERVICES[@]}"; do
  IFS=':' read -r name port path <<< "$svc"
  url="http://localhost:${port}${path}"
  
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url")
  
  if [ "$status" != "200" ]; then
    FAILED+=("$name:$status")
    # 尝试重启
    docker restart $name > /dev/null 2>&1
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  # 发告警（这里用 mail，可以换成微信/钉钉 webhook）
  echo "[$(date)] 服务异常: ${FAILED[*]}" | mail -s "AI 中转站告警" $ALERT_EMAIL
fi

# 输出到日志
echo "[$(date)] Checked ${#SERVICES[@]} services, ${#FAILED[@]} failed"
```

加到 crontab：

```bash
chmod +x /opt/ai-services/scripts/health-check.sh
crontab -e
# 添加：
* * * * * /opt/ai-services/scripts/health-check.sh >> /var/log/ai-health.log 2>&1
# 每分钟执行一次（脚本内部有 30 秒超时）
```

### Layer 3：上游渠道可用性（每小时）

new-api 自带渠道测试，但我们可以加一个更深的检查——**真正调通一次 AI 请求**：

```bash
#!/bin/bash
# /opt/ai-services/scripts/upstream-check.sh

NEWAPI="http://localhost:3000/v1/chat/completions"
ADMIN_TOKEN="your-admin-token"  # 在 new-api 用户管理里给 root 生成

# 测试 OpenAI 渠道
test_channel() {
  local name=$1
  local model=$2
  
  resp=$(curl -s -X POST "$NEWAPI" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d "{\"model\": \"$model\", \"messages\": [{\"role\": \"user\", \"content\": \"ping\"}], \"max_tokens\": 5}" \
    --max-time 30)
  
  if echo "$resp" | grep -q '"choices"'; then
    echo "✅ $name ($model) OK"
    return 0
  else
    echo "❌ $name ($model) FAIL: $resp"
    return 1
  fi
}

test_channel "openai" "gpt-4o-mini"
test_channel "anthropic" "claude-haiku-4-5-20251001"
test_channel "kiro" "claude-sonnet-4-5-20250929"
```

定时每小时跑一次：

```bash
crontab -e
0 * * * * /opt/ai-services/scripts/upstream-check.sh >> /var/log/upstream-check.log 2>&1
```

## 二、用量统计：看清每一分钱花在哪

### new-api Web UI 自带看板

直接看 Web UI → 控制台：

- **总览**：今日/本周/本月调用次数、token 消耗、估算成本
- **用户维度**：每个用户的调用次数、token、余额变化
- **渠道维度**：每个上游的成功率、响应时间
- **模型维度**：每个模型的调用比例

### SQL 自定义统计

new-api 数据库是 SQLite，可以直接查：

```bash
DB="/opt/ai-services/new-api/data/one-api.db"

# 今天的用量
sqlite3 "$DB" "SELECT 
  COUNT(*) AS requests,
  SUM(prompt_tokens + completion_tokens) AS total_tokens
FROM logs 
WHERE created_at > strftime('%s', 'now', 'start of day');"

# 各用户用量排行
sqlite3 "$DB" "SELECT 
  u.username,
  COUNT(*) AS requests,
  SUM(l.prompt_tokens + l.completion_tokens) AS total_tokens
FROM logs l
JOIN users u ON l.user_id = u.id
WHERE l.created_at > strftime('%s', 'now', '-7 days')
GROUP BY u.id
ORDER BY total_tokens DESC
LIMIT 10;"

# 各模型用量分布
sqlite3 "$DB" "SELECT 
  model,
  COUNT(*) AS requests,
  SUM(prompt_tokens) AS input_tokens,
  SUM(completion_tokens) AS output_tokens
FROM logs
WHERE created_at > strftime('%s', 'now', '-30 days')
GROUP BY model
ORDER BY requests DESC;"

# 各渠道成功率
sqlite3 "$DB" "SELECT 
  c.name AS channel,
  COUNT(*) AS total,
  SUM(CASE WHEN l.status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success,
  ROUND(100.0 * SUM(CASE WHEN l.status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) / COUNT(*), 2) AS success_pct
FROM logs l
JOIN channels c ON l.channel_id = c.id
WHERE l.created_at > strftime('%s', 'now', '-7 days')
GROUP BY c.id
ORDER BY total DESC;"

# 估算成本（按官方价格）
sqlite3 "$DB" "SELECT 
  model,
  SUM(prompt_tokens) AS in_tok,
  SUM(completion_tokens) AS out_tok,
  ROUND(SUM(prompt_tokens) * 0.000003 + SUM(completion_tokens) * 0.000015, 4) AS cost_usd
FROM logs
WHERE created_at > strftime('%s', 'now', '-30 days')
GROUP BY model
ORDER BY cost_usd DESC;"
```

### 写一个每日报告脚本

```bash
#!/bin/bash
# /opt/ai-services/scripts/daily-report.sh
# 每天早上 8 点跑，发邮件

DB="/opt/ai-services/new-api/data/one-api.db"
EMAIL="you@example.com"

REPORT=$(sqlite3 -header -column "$DB" "
SELECT model, COUNT(*) AS requests, 
       SUM(prompt_tokens + completion_tokens) AS total_tokens
FROM logs
WHERE created_at > strftime('%s', 'now', '-1 day')
GROUP BY model
ORDER BY requests DESC;")

cat <<EOF | mail -s "AI 中转站日报 $(date +%Y-%m-%d)" $EMAIL
AI 中转站昨日用量统计：

$REPORT

详细数据请登录 https://api.your-domain.xyz 查看。
EOF
```

加到 crontab：

```bash
0 8 * * * /opt/ai-services/scripts/daily-report.sh
```

## 三、Token 自动刷新：kiro-rs 是最麻烦的

### 问题描述

kiro-rs 的 refresh token **没有 refresh path**（这是 AWS 的设计），意味着：
- access token 过期：自动用 refresh token 换 ✅
- refresh token 过期：必须重新走 OAuth 登录 ❌

实测 refresh token 有效期大约 **几天到几周**，失效后必须：
1. 在本地 Kiro IDE / Kiro CLI 重新登录
2. 重新提取 credentials.json
3. 上传到服务器

### 半自动化方案

#### Step 1：本地加一个刷新脚本

在 Mac 上创建：

```bash
#!/bin/bash
# ~/bin/refresh-kiro-credentials.sh

DB="$HOME/Library/Application Support/kiro-cli/data.sqlite3"

# 检查是否有 kiro-cli 登录
if [ ! -f "$DB" ]; then
  echo "kiro-cli 未安装或未登录"
  exit 1
fi

# 提取最新 token
sqlite3 "$DB" "SELECT value FROM auth_kv WHERE key='kirocli:social:token';" > /tmp/kiro-token.json

# 转换为 kiro-rs 格式
python3 << 'PYEOF' > /tmp/credentials.json
import json
with open('/tmp/kiro-token.json') as f:
    data = json.load(f)
creds = {
    "refreshToken": data['refresh_token'],
    "accessToken": data['access_token'],
    "expiresAt": data['expires_at'],
    "authMethod": "social",
    "profileArn": data.get('profile_arn', ''),
    "machineId": "DE2614E04B785A76A53621E25363C1BB"
}
print(json.dumps(creds, indent=2))
PYEOF

# 上传到服务器
sshpass -p 'your-ssh-password' scp -o StrictHostKeyChecking=no /tmp/credentials.json \
  root@your-server-ip:/opt/ai-services/kiro-rs/credentials.json

# 重启 kiro-rs
sshpass -p 'your-ssh-password' ssh -o StrictHostKeyChecking=no root@your-server-ip \
  "cd /opt/ai-services && docker compose restart kiro-rs"

echo "[$(date)] kiro-rs 凭据已更新"
```

#### Step 2：检测失效

在服务器上加一个检查脚本：

```bash
#!/bin/bash
# /opt/ai-services/scripts/check-kiro.sh

ADMIN_TOKEN="sk-kiro-admin-2026"
CHECK=$(curl -s http://localhost:8990/api/admin/credentials \
  -H "x-api-key: $ADMIN_TOKEN")

# 看 refresh failure count
FAIL_COUNT=$(echo "$CHECK" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data.get('credentials', []):
    print(c.get('refreshFailureCount', 0))
" | head -1)

# 检查 disabled 状态
DISABLED=$(echo "$CHECK" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data.get('credentials', []):
    print(c.get('disabled', False))
" | head -1)

if [ "$DISABLED" = "True" ] || [ "$FAIL_COUNT" -gt 5 ]; then
  echo "[$(date)] kiro-rs 凭据异常，refreshFailureCount=$FAIL_COUNT, disabled=$DISABLED"
  # 发邮件/微信通知
  echo "kiro-rs refresh failure count: $FAIL_COUNT, disabled: $DISABLED" | \
    mail -s "kiro-rs 告警" you@example.com
fi
```

加到 crontab：

```bash
# 每 10 分钟检查一次
*/10 * * * * /opt/ai-services/scripts/check-kiro.sh
```

### 真正的全自动化（高级）

如果你不想每次手动登录 Kiro CLI，可以写一个**自动化重登**脚本（需要 Kiro IDE 配合）：

```bash
# 这部分比较 hack，不推荐生产用
# 思路：
# 1. 检测到 refresh token 失效
# 2. 自动启动 Kiro IDE 启动登录
# 3. 用户扫码或 OAuth 授权
# 4. 自动提取新 token
# 5. 自动上传
```

> 实际经验：**半自动化方案**已经够用。每次失效手动跑一次脚本也就 5 分钟。

## 四、异常告警：集成微信 / 邮件 / 钉钉

### 微信推送（推荐）

#### Step 1：创建企业微信群机器人

群聊 → 群机器人 → 添加 → 获取 Webhook URL：

```
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
```

#### Step 2：写发送函数

```bash
#!/bin/bash
# 通用微信告警函数

send_wechat_alert() {
  local title="$1"
  local content="$2"
  local webhook="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
  
  curl -s -X POST "$webhook" \
    -H "Content-Type: application/json" \
    -d "{
      \"msgtype\": \"markdown\",
      \"markdown\": {
        \"content\": \"## $title\\n\\n$content\"
      }
    }"
}

# 使用示例
send_wechat_alert "AI 中转站告警" "服务 new-api 异常 HTTP 503"
```

### 钉钉推送

类似：

```bash
send_dingtalk_alert() {
  local title="$1"
  local content="$2"
  local webhook="https://oapi.dingtalk.com/robot/send?access_token=xxx"
  
  curl -s -X POST "$webhook" \
    -H "Content-Type: application/json" \
    -d "{
      \"msgtype\": \"markdown\",
      \"markdown\": {
        \"title\": \"$title\",
        \"text\": \"$content\"
      }
    }"
}
```

### 邮件告警（最简单）

```bash
# 安装 sendmail
dnf install sendmail -y
systemctl enable sendmail
systemctl start sendmail

# 发送
echo "服务异常" | mail -s "AI 中转站告警" you@example.com
```

### 集成到监控脚本

```bash
#!/bin/bash
# /opt/ai-services/scripts/notify.sh

notify() {
  local level="$1"     # info / warning / error
  local title="$2"
  local content="$3"
  
  case $level in
    info)
      echo "ℹ️ $title: $content" | mail -s "[INFO] $title" you@example.com
      ;;
    warning)
      echo "⚠️ $title: $content" | mail -s "[WARNING] $title" you@example.com
      send_wechat_alert "$title" "$content"
      ;;
    error)
      echo "🚨 $title: $content" | mail -s "[ERROR] $title" you@example.com
      send_wechat_alert "🚨 $title" "$content"
      ;;
  esac
}
```

## 五、容量规划：什么时候该升级

### 监控指标

```bash
# 服务器 CPU 使用率
top -bn1 | grep "Cpu(s)" | awk '{print $2}'

# 内存使用率
free -m | awk 'NR==2{printf "%.1f%%", $3/$2*100}'

# 磁盘使用率
df -h / | awk 'NR==2{print $5}'

# 网络带宽
iftop -i eth0
```

### 何时升级

| 指标 | 阈值 | 动作 |
|------|------|------|
| CPU | >80% 持续 5 分钟 | 升级到 4 核 |
| 内存 | >85% | 升级到 8GB |
| 磁盘 | >80% | 清理日志 / 升级磁盘 |
| 带宽 | 持续 80%+ | 升级带宽 |
| Token 消耗 | 接近上游限额 | 添加新 Key 或换套餐 |

### 自动扩容（高级）

如果你用腾讯云、阿里云，可以配置**弹性伸缩**：
- 监控 CPU > 70% 持续 3 分钟 → 自动开新机器
- CPU < 30% 持续 10 分钟 → 关掉多余机器

但是对中转站来说，**单台机器足够 5-10 人小团队**，扩容需求不大。

## 六、备份与恢复

### 关键备份对象

```
/opt/ai-services/
├── new-api/data/one-api.db        # ⭐ 用户、Token、用量、渠道配置
├── kiro-rs/credentials.json       # ⭐ Kiro 凭据
├── cliproxyapi/config.yaml        # ⭐ 上游 Key
├── windsurf-api/.env               # ⭐ API Key
├── docker-compose.yml              # 服务编排
└── ~/.cloudflared/                 # Tunnel 配置（如果用 Named Tunnel）
```

### 自动备份脚本

```bash
#!/bin/bash
# /opt/ai-services/scripts/backup.sh

BACKUP_DIR="/backup/ai-services"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

# 创建压缩包
tar czf "$BACKUP_DIR/ai-services-$DATE.tar.gz" \
  /opt/ai-services/new-api/data/one-api.db \
  /opt/ai-services/kiro-rs/credentials.json \
  /opt/ai-services/cliproxyapi/config.yaml \
  /opt/ai-services/windsurf-api/.env \
  /opt/ai-services/docker-compose.yml \
  ~/.cloudflared/ \
  2>/dev/null

# 只保留最近 30 天的备份
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +30 -delete

echo "[$(date)] 备份完成: $BACKUP_DIR/ai-services-$DATE.tar.gz"

# 可选：上传到云存储
# rclone copy "$BACKUP_DIR/ai-services-$DATE.tar.gz" s3:my-backup/ai-services/
```

加到 crontab：

```bash
# 每天凌晨 3 点备份
0 3 * * * /opt/ai-services/scripts/backup.sh >> /var/log/ai-backup.log 2>&1
```

### 上传到 S3 / OSS（推荐）

```bash
# 安装 rclone
curl https://rclone.org/install.sh | bash

# 配置
rclone config
# 跟着提示配置你的 S3 / OSS / 腾讯云 COS

# 修改 backup.sh 加上上传
rclone copy "$BACKUP_DIR/ai-services-$DATE.tar.gz" \
  s3:my-ai-backup/$(date +%Y)/$(date +%m)/
```

### 恢复

```bash
# 1. 解压备份
cd /tmp
tar xzf /backup/ai-services/ai-services-20260722_030000.tar.gz

# 2. 恢复文件
cp /tmp/opt/ai-services/new-api/data/one-api.db /opt/ai-services/new-api/data/
cp /tmp/opt/ai-services/kiro-rs/credentials.json /opt/ai-services/kiro-rs/

# 3. 重启服务
cd /opt/ai-services
docker compose restart

# 4. 验证
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer test-token" \
  -d '{"model": "gpt-4o-mini", "messages": []}' -v 2>&1 | head -5
```

## 七、故障排查清单

### 症状 → 排查 → 解决

#### 症状 1：客户端连不上

```bash
# 排查
nslookup api.your-domain.xyz        # DNS 解析？
curl -I https://api.your-domain.xyz/  # HTTPS 通了？

# 解决：重启 cloudflared
sudo systemctl restart cloudflared
```

#### 症状 2：HTTP 500

```bash
# 排查
docker logs new-api --tail 50

# 常见：数据库锁
# 解决：等几秒重试，或重启
docker compose restart new-api
```

#### 症状 3：HTTP 502

```bash
# 排查：上游挂了
curl http://localhost:3000/   # new-api 本地
curl http://localhost:8317/   # CLIProxyAPI 本地

# 解决：重启出问题的服务
docker compose restart cliproxyapi
```

#### 症状 4：HTTP 429（限速）

```bash
# 排查：上游余额或 TPM 耗尽
# new-api 自动切到备用渠道，应该自动恢复

# 手动查余额
登录 OpenAI 控制台 → Usage
```

#### 症状 5：kiro-rs 报"refresh failure"

```bash
# 排查
curl http://localhost:8990/api/admin/credentials \
  -H "x-api-key: sk-kiro-admin-2026"

# 解决：手动刷新（参考前面第三章）
```

#### 症状 6：客户端提示"模型不存在"

```bash
# 排查：abilities 表里没有
sqlite3 /opt/ai-services/new-api/data/one-api.db \
  "SELECT * FROM abilities WHERE model = 'claude-sonnet-4-5-20250929';"

# 解决：添加能力映射
sqlite3 /opt/ai-services/new-api/data/one-api.db \
  "INSERT INTO abilities (...) VALUES (...);"
```

## 八、运维手册（团队共享）

把上面所有脚本放到一个目录，写一个 README：

```bash
/opt/ai-services/
├── scripts/
│   ├── health-check.sh         # 健康检查
│   ├── upstream-check.sh       # 上游可用性
│   ├── check-kiro.sh           # Kiro 凭据监控
│   ├── daily-report.sh         # 日报
│   ├── notify.sh               # 告警发送
│   ├── backup.sh                # 自动备份
│   └── README.md                # 运维手册
```

运维手册内容：

```markdown
# AI 中转站运维手册

## 日常检查
- 早上看日报邮件
- 检查 Slack/邮件告警

## 每周维护
- 清理 docker logs（> 1GB 时）
- 检查备份文件
- 检查 Kiro 凭据状态

## 故障响应
- 1 分钟内：自动恢复（Docker 重启）
- 5 分钟内：手动介入
- 30 分钟内：恢复备份

## 紧急联系
- 系统管理员: xxx
- 网络/Cloudflare: xxx
- 数据库: xxx
```

## 本篇总结

本篇把"长期稳定运行"的所有关键点讲完了：

- ✅ **健康检查**：3 层监控（容器 / HTTP / 上游）
- ✅ **用量统计**：Web UI + SQL + 日报
- ✅ **Token 刷新**：kiro-rs 半自动方案
- ✅ **异常告警**：微信 / 钉钉 / 邮件
- ✅ **容量规划**：监控指标 + 升级时机
- ✅ **备份恢复**：每日自动备份 + S3 上传
- ✅ **故障排查清单**：6 种常见症状速查
- ✅ **运维手册**：团队协作模板

下一篇《07 合规与安全》是这个系列的最后一篇，会讲**最重要的边界问题**——自用 vs 商用、API Key 安全、SSH 加固、数据备份的合规性，以及为什么"绝不能用来对外转售"。

## 参考资料

- [new-api 运维文档](https://github.com/QuantumNous/new-api/)
- [Docker 健康检查最佳实践](https://docs.docker.com/engine/reference/run/#healthcheck)
- [企业微信机器人文档](https://developer.work.weixin.qq.com/document/path/91770)
- [rclone 文档](https://rclone.org/docs/)

---

**下一步**：等你把上面的监控脚本都部署好，告诉我，我们写系列最后一篇《07 合规与安全》。