---
title: "AI 中转站落地实践（二）：服务部署与账号配置"
date: 2026-07-22
description: "系列第 2 篇：把 new-api / CLIProxyAPI / kiro-rs / WindsurfAPI 四个服务用 docker-compose 一键跑起来，详细讲解每个服务的账号配置和 Token 分配机制。"
tags: [AI 中转站, Docker Compose, new-api, CLIProxyAPI, Kiro, Windsurf]
draft: false
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · **02 服务部署** · 03 网络打通 · 04 渠道配置 · 05 客户端使用 · 06 运维监控 · 07 合规与安全

上一篇把架构和服务器选型讲清楚了，这一篇进入硬核：**4 个服务怎么跑起来，怎么配置账号，怎么把 Token 分发给团队成员**。

## 部署总览

四个服务分两类：

| 类型 | 服务 | 是否需要源码构建 |
|------|------|------------------|
| **有官方镜像** | kiro-rs、new-api | ✅ 直接 pull |
| **需源码构建** | CLIProxyAPI、WindsurfAPI | ⚠️ 需要 clone + build |

> 顺序很重要：**先上游服务，再聚合网关**。new-api 依赖其他三个的地址和 Key 才能正常工作。

## Step 1：部署 new-api（聚合网关）

new-api 是统一入口，先把它跑起来，后台可以慢慢配。

### 1.1 创建工作目录

```bash
mkdir -p /opt/ai-services/new-api/data
cd /opt/ai-services/new-api
```

### 1.2 启动容器

```bash
docker run -d \
  --name new-api \
  --restart always \
  -p 3000:3000 \
  -v $(pwd)/data:/data \
  -e TZ=Asia/Shanghai \
  calciumion/new-api:latest

# 验证
sleep 5
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/
```

返回 200 表示启动成功。

### 1.3 第一次登录

浏览器打开 `http://服务器IP:3000`：

- 用户名：`root`
- 密码：`123456`

**第一件事：立刻修改默认密码**。

### 1.4 关闭自注册（强烈建议）

> **系统设置 → 运营设置 → 用户注册设置 → 关闭"允许用户注册"**

否则任何知道你域名的人都能注册账号。

## Step 2：部署 kiro-rs（AWS Kiro 代理）

如果你没有 AWS Kiro 账号，可以跳过这步。kiro-rs 的特别之处在于：它使用 AWS Builder ID 做 OAuth 登录。

### 2.1 准备 Kiro 凭据

kiro-rs 接受本地 Kiro CLI / IDE 提取出来的 JSON：

```bash
# 在你本地 Mac / Linux 装 Kiro CLI 或 Kiro IDE
# 用 Google 邮箱登录

# Mac 上提取数据库中的 token
DB="$HOME/Library/Application Support/kiro-cli/data.sqlite3"
sqlite3 "$DB" "SELECT value FROM auth_kv WHERE key='kirocli:social:token';" > /tmp/kiro-token.json
```

提取后是这种结构：

```json
{
  "access_token": "aoaAAAAA...",
  "expires_at": "2026-07-21T09:43:27.154593Z",
  "refresh_token": "aorAAAAA...",
  "provider": "google",
  "profile_arn": "arn:aws:codewhisperer:us-east-1:..."
}
```

### 2.2 转换为 kiro-rs 格式

```bash
python3 << 'PYEOF'
import json

with open('/tmp/kiro-token.json') as f:
    data = json.load(f)

creds = {
    "refreshToken": data['refresh_token'],
    "accessToken": data['access_token'],          # ← 关键！必须有
    "expiresAt": data['expires_at'],
    "authMethod": "social",
    "profileArn": data.get('profile_arn', ''),
    "machineId": "DE2614E04B785A76A53621E25363C1BB"  # 任意 64 字符
}

with open('/opt/ai-services/kiro-rs/credentials.json', 'w') as f:
    json.dump(creds, f, indent=2)
PYEOF
```

> ⚠️ `accessToken` 是必需字段。漏了这个字段会导致 kiro-rs 反复刷新失败。

### 2.3 启动容器

```bash
mkdir -p /opt/ai-services/kiro-rs/data
cd /opt/ai-services

docker run -d \
  --name kiro-rs \
  --restart always \
  -p 8990:8990 \
  -v $(pwd)/kiro-rs/config.json:/app/config/config.json \
  -v $(pwd)/kiro-rs/credentials.json:/app/config/credentials.json \
  ghcr.io/hank9999/kiro-rs:latest
```

### 2.4 验证 Kiro 凭据生效

```bash
curl -s http://localhost:8990/v1/models \
  -H "x-api-key: sk-kiro-rs-default-key-2026" \
  -H "anthropic-version: 2023-06-01" | python3 -m json.tool | head -20
```

看到模型列表（如 `claude-sonnet-4-5-20250929`）说明凭据加载成功。

### 2.5 Admin UI 管理

```
http://服务器IP:8990/admin
密钥: sk-kiro-admin-2026（config.json 里设置）
```

可以查看余额、强制刷新 Token、启用/禁用凭据。

## Step 3：部署 CLIProxyAPI（通用协议转换）

CLIProxyAPI 是 Go 项目，没有官方 Docker 镜像，需要源码构建。

### 3.1 克隆源码并构建

```bash
cd /opt/ai-services
git clone --depth 1 https://github.com/router-for-me/CLIProxyAPI.git cliproxyapi-src
cd cliproxyapi-src

# 选 2：从源码构建
echo "2" | bash docker-build.sh

# 构建完后会留下 cli-proxy-api:local 镜像
docker images | grep cli-proxy-api
```

### 3.2 配置文件

CLIProxyAPI 默认监听 8317 端口。`config.example.yaml` 在源码里，需要复制并修改：

```bash
mkdir -p /opt/ai-services/cliproxyapi/data
cat > /opt/ai-services/cliproxyapi/config.yaml << 'EOF'
host: "0.0.0.0"
port: 8317

# 客户端访问密钥（new-api 会用这个）
api-keys:
  - "sk-cliproxy-default-key-2026"

# 上游 AI 公司 Key（必须改成你自己的）
providers:
  - name: openai
    base-url: https://api.openai.com
    api-key: sk-your-real-openai-key
    
  - name: anthropic
    base-url: https://api.anthropic.com
    api-key: sk-ant-your-real-anthropic-key
    
  - name: gemini
    base-url: https://generativelanguage.googleapis.com
    api-key: your-real-gemini-key

debug: false
EOF
```

### 3.3 启动容器

```bash
cd /opt/ai-services

docker run -d \
  --name cliproxyapi \
  --restart always \
  -p 8317:8317 \
  -v $(pwd)/cliproxyapi/config.yaml:/CLIProxyAPI/config.yaml \
  cli-proxy-api:local
```

### 3.4 验证

```bash
# CLIProxyAPI 接受 OpenAI 格式
curl -s -X POST http://localhost:8317/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-cliproxy-default-key-2026" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hi"}],
    "max_tokens": 30
  }'
```

返回 `choices` 数组说明调通了 OpenAI。

## Step 4：部署 WindsurfAPI（Windsurf/Devin 代理）

WindsurfAPI 是 Node.js 项目，也没有官方镜像，需要源码构建。

### 4.1 克隆并构建

```bash
cd /opt/ai-services
git clone --depth 1 https://github.com/dwgx/WindsurfAPI.git windsurf-api-src
cd windsurf-api-src

docker build -t windsurf-api:local .
```

### 4.2 配置 .env

```bash
cat > /opt/ai-services/windsurf-api/.env << 'EOF'
PORT=3003
HOST=0.0.0.0
DATA_DIR=/data

# 客户端访问密钥
API_KEY=sk-windsurf-default-key-2026

# Dashboard 密码（访问 3003/dashboard 用）
DASHBOARD_PASSWORD=admin2026
EOF
```

### 4.3 启动容器

```bash
cd /opt/ai-services

docker run -d \
  --name windsurf-api \
  --restart always \
  -p 3003:3003 \
  -v $(pwd)/windsurf-api/.env:/app/.env \
  windsurf-api:local
```

### 4.4 获取 Windsurf API Key

Dashboard 在 `http://服务器IP:3003/dashboard`，密码 `admin2026`。

#### 推荐路径：邮箱 OTP 自动注册

1. 进入「**登录取号**」→「**邮箱 OTP**」
2. 填 Gmail + IMAP 应用专用密码（不是主密码）
3. 系统自动收验证码 + 注册新 Windsurf 账号
4. 返回 `{ apiKey, name, apiServerUrl }`

#### 已有 Windsurf 账号

进入「**登录取号**」→「**邮箱密码**」直接登录。

账号会自动存储到 `accounts.creds.json`（加密）。

## Step 5：统一编排（docker-compose）

把 4 个容器合成一个 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  # 上游 1：通用 OpenAI / Anthropic / Gemini 转换
  cliproxyapi:
    image: cli-proxy-api:local
    container_name: cliproxyapi
    restart: always
    ports: ["8317:8317"]
    volumes:
      - ./cliproxyapi/config.yaml:/CLIProxyAPI/config.yaml
      - ./cliproxyapi/data:/CLIProxyAPI/auths
    environment:
      - TZ=Asia/Shanghai

  # 上游 2：AWS Kiro 账号的 Claude 模型
  kiro-rs:
    image: ghcr.io/hank9999/kiro-rs:latest
    container_name: kiro-rs
    restart: always
    ports: ["8990:8990"]
    volumes:
      - ./kiro-rs/config.json:/app/config/config.json
      - ./kiro-rs/credentials.json:/app/config/credentials.json
    environment:
      - TZ=Asia/Shanghai

  # 上游 3：Windsurf/Devin 模型
  windsurf-api:
    image: windsurf-api:local
    container_name: windsurf-api
    restart: always
    ports: ["3003:3003"]
    volumes:
      - ./windsurf-api/.env:/app/.env
    env_file: ./windsurf-api/.env

  # 聚合网关：用户看到的唯一入口
  new-api:
    image: calciumion/new-api:latest
    container_name: new-api
    restart: always
    ports: ["3000:3000"]
    volumes:
      - ./new-api/data:/data
    environment:
      - TZ=Asia/Shanghai
```

启动：

```bash
cd /opt/ai-services
docker compose up -d
docker compose ps
```

## Step 6：在 new-api 中配置上游渠道

浏览器打开 `http://服务器IP:3000`，登录。

### 6.1 添加渠道

进入「**渠道**」→「**添加渠道**」：

#### 渠道 A：CLIProxyAPI（OpenAI 协议）

```
类型:     OpenAI
名称:     openai
Base URL: http://cliproxyapi:8317/v1        # ← Docker 网络内部地址
API Key:  sk-cliproxy-default-key-2026
模型:     gpt-4o, gpt-4o-mini, gpt-3.5-turbo
分组:     default
```

> 关键：Base URL 用 Docker 内部地址（`http://cliproxyapi:8317`），不是 localhost。所有容器在同一个 docker-compose 网络里。

#### 渠道 B：CLIProxyAPI（Anthropic 协议）

```
类型:     Anthropic
名称:     anthropic
Base URL: http://cliproxyapi:8317
API Key:  sk-cliproxy-default-key-2026
模型:     claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001
```

#### 渠道 C：kiro-rs

```
类型:     Anthropic
名称:     kiro
Base URL: http://kiro-rs:8990
API Key:  sk-kiro-rs-default-key-2026
模型:     claude-sonnet-4-5-20250929
```

#### 渠道 D：WindsurfAPI

```
类型:     OpenAI
名称:     windsurf
Base URL: http://windsurf-api:3003/v1
API Key:  sk-windsurf-default-key-2026
模型:     gpt-4o, claude-sonnet-4-5-20250929 等
```

### 6.2 new-api 内部的两个关键数据库表

new-api 用 SQLite 存配置。除了在 Web UI 添加渠道，还需要让**模型-渠道**的映射生效：

```sql
-- 把模型授权给渠道（groups=default）
INSERT OR REPLACE INTO abilities
  ("group", model, channel_id, enabled, priority, weight)
VALUES
  ('default', 'gpt-4o', 1, 1, 0, 10),
  ('default', 'claude-sonnet-4-5-20250929', 1, 1, 0, 10),
  ...;
```

如果用 Web UI 添加渠道，UI 会自动写入这张表。

### 6.3 开启"自用模式"

> **系统设置 → 运营设置 → 启用 SelfUseModeEnabled**

开启后无需配置每个模型的价格，适合个人/团队内部使用。

## Step 7：创建团队账号和分发 Token

### 7.1 创建用户

Web UI → 「**用户管理**」→「**添加用户**」：

| 字段 | 填法 |
|------|------|
| 用户名 | `dev-张三` |
| 密码 | 随机生成（第一次登录后改）|
| 邮箱 | zhangsan@team.com（可选）|
| 分组 | `default` |
| 余额 | 100（美元等值，作为限额参考）|

### 7.2 生成 API Token

进入用户详情 → 「**生成令牌**」→ 复制 Token。

Token 格式类似：`sk-user-xxx`

### 7.3 分发给团队成员

```
Base URL:  https://你的new-api-tunnel.trycloudflare.com/v1
API Key:   sk-user-xxx（每人独立）
类型:      OpenAI（new-api 同时支持 OpenAI 和 Anthropic 协议）
```

### 7.4 多渠道负载均衡

new-api 支持**权重 + 优先级**：

```sql
-- 渠道 1（OpenAI API）权重 10
-- 渠道 2（kiro-rs）权重 5
-- 同时请求时 2:1 概率分配到 OpenAI
```

**故障自动转移**：一个渠道挂了，自动切到下一个。

## Step 8：完整运转机制

把链路完整串一遍：

```
1. 用户在 Claude Code 中调用
   POST https://new-api/v1/messages
   Headers: x-api-key: sk-user-xxx
   Body: {model: "claude-sonnet-4-5-20250929", messages: [...]}

2. new-api 鉴权
   - 查询 tokens 表，验证 sk-user-xxx
   - 检查 user_id 状态、余额、分组权限

3. 路由决策
   - 查询 abilities 表，找到能提供 claude-sonnet-4-5-20250929 的渠道
   - 按权重选一个（kiro-rs）

4. 转发到 kiro-rs
   POST http://kiro-rs:8990/v1/messages
   Headers: x-api-key: sk-kiro-rs-default-key-2026

5. kiro-rs 调用 AWS
   - 用 credentials.json 里的 accessToken 调 AWS CodeWhisperer
   - AWS 验证返回 Claude 响应

6. 流式响应返回
   AWS → kiro-rs → new-api（记录用量） → 客户端
```

### 用量如何记录

new-api 在 `logs` 表里记录每个请求：

```sql
SELECT username, model, prompt_tokens, completion_tokens, 
       (prompt_tokens + completion_tokens) * 0.000005 as cost_usd
FROM logs
WHERE created_at > datetime('now', '-7 days')
ORDER BY created_at DESC;
```

可以按用户、模型、时间维度统计。

## Step 9：客户端集成

### Claude Code

```bash
export ANTHROPIC_BASE_URL="https://你的new-api-tunnel/v1"
export ANTHROPIC_AUTH_TOKEN="sk-user-xxx"

# 或写到 ~/.zshrc 永久生效
echo 'export ANTHROPIC_BASE_URL="..."' >> ~/.zshrc
```

### Cherry Studio

```
Base URL: https://你的new-api-tunnel/v1
API Key:  sk-user-xxx
类型:      OpenAI
```

### CC Switch（多渠道切换工具）

CC Switch 在 `~/.cc-switch/cc-switch.db` 存配置。可以把多个 base_url / token 预设进去，一键切换。

## Step 10：常见问题

### Q: kiro-rs 报"刷新失败"

检查 `credentials.json` 是否包含 `accessToken` 字段（必须）。同时 `machineId` 用任意 64 字符的字符串。

### Q: CLIProxyAPI 启动后 health check 失败

查看日志：

```bash
docker logs cliproxyapi --tail 30
```

99% 是 `config.yaml` 的 `providers` 字段 Key 没填对。

### Q: new-api 报"模型未配置价格"

到「**系统设置 → 运营设置**」开启 **SelfUseModeEnabled**，或给每个模型配置价格。

### Q: new-api 报"无效 Token"

new-api 数据库存的 Token 不带 `sk-` 前缀（HTTP Header 里带）。Web UI 里填的时候**带上 `sk-`**，存进去时系统会剥离。

## 本篇总结

本篇完成了：

- ✅ **4 个服务部署**：new-api + CLIProxyAPI + kiro-rs + WindsurfAPI
- ✅ **配置账号**：OpenAI / Anthropic / Kiro / Windsurf 都接上了
- ✅ **运转机制**：完整的鉴权→路由→转发→计费链路
- ✅ **Token 分发**：用 new-api 给每个团队成员生成独立 Token

下一篇《03 网络打通》会讲怎么用 Cloudflare Tunnel 把这些服务暴露到公网，让国内客户端能稳定访问。

## 参考资料

- [new-api 部署文档](https://github.com/QuantumNous/new-api/)
- [CLIProxyAPI 部署指南](https://github.com/router-for-me/CLIProxyAPI)
- [kiro.rs 配置说明](https://github.com/hank9999/kiro.rs)
- [WindsurfAPI 部署文档](https://github.com/dwgx/WindsurfAPI)
- [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)

---
