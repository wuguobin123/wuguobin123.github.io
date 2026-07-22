---
title: "AI 中转站落地实践（七）：合规边界与安全加固"
date: 2026-07-22
description: "系列收官篇：明确自用与商用的合规边界、解读 OpenAI / Anthropic ToS、API Key 加密存储、SSH 加固、Cloudflare WAF、数据隐私与应急响应预案。"
tags: [AI 中转站, 合规, 安全, API Key, SSH, Cloudflare WAF, 数据隐私]
draft: false
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · 03 网络打通 · 04 渠道配置 · 05 客户端使用 · 06 运维监控 · **07 合规与安全**

这个系列从架构、部署、配置、客户端、运维写到这一篇，**最后必须把"边界"讲清楚**：

- 自用和商用的红线在哪里？
- 账号会不会被封？
- 数据隐私怎么处理？
- 出了事怎么应急？

这一篇不是技术文章，**是"规则与安全"**——比代码更重要。

## 一、合规边界：最核心的规则

### 一句话原则

> **这套中转站只能用于"个人 / 小团队内部研发提效"，严禁对外分发、严禁商业化运营。**

### 三条红线

| 红线 | 严重程度 | 后果 |
|------|----------|------|
| 🔴 **对外销售 API 调用** | 严重违规 | OpenAI/Anthropic 永久封号 + 余额不退 |
| 🔴 **大规模分发 Token / 套餐转售** | 严重违规 | 同上 |
| 🟡 **少量代付 / 朋友间共享** | 灰色地带 | 可能被认定违规，建议避免 |
| 🟢 **个人 + 内部团队研发使用** | 完全合规 | 没问题 |

### 灰色地带怎么判断

**关键问题**：你做的事算"内部研发"还是"对外分发"？

```
✅ 自用 / 内部研发：
  - 我自己用 Claude Code 写代码
  - 5-10 人小团队内部用
  - 公司内部培训 AI 工具
  - 学术研究、非商业项目

❌ 对外分发 / 商业化：
  - "ChatGPT Plus 共享账号 ¥50/月"
  - "稳定 API 中转，按 token 计费"
  - 任何形式的收费
  - 即使不收费，但分发到组织外部多个人
```

## 二、上游 ToS 解读

### OpenAI Terms of Use 关键条款

来自 https://openai.com/policies/row-terms-of-use/：

> **"You may not use our Services to develop products or services that compete with OpenAI."**
> **"You may not share your API Key with any third party."**

**翻译**：
- 不能用 OpenAI API 开发与 OpenAI 竞争的产品 → 不能搞"OpenAI 替代品"
- **API Key 不能分享给第三方** → 不能团队多人共用同一个 Key

> ⚠️ "API Key 不能分享" 这一条很严格。即使是同事之间共用，也算违规。

### Anthropic Terms of Service 关键条款

来自 https://www.anthropic.com/legal/commercial-terms：

> **"You may not... share your login credentials with any third party or use your login credentials to provide services to any third party."**

**翻译**：不能分享登录凭据、不能用你的凭据给第三方提供服务。

> Anthropic 比 OpenAI 更严格，**任何形式的代付都算违规**。

### Google Gemini Terms

来自 https://ai.google.dev/terms：

> **"You may not transfer your API access to any other party."**

### AWS CodeWhisperer / Kiro 条款

> AWS 的服务条款里也禁止账号分享，但**个人开发者账号**的容忍度比企业宽。

### 总结：什么是"自用"的边界

| 行为 | 是否合规 |
|------|---------|
| **你个人用** | ✅ 完全合规 |
| **公司同事之间用**（同一家公司、同一项目）| ⚠️ 灰色，建议走企业账户 |
| **朋友 / 同学 / 远程团队** | 🟡 风险，建议避免 |
| **对外销售 / 转售 / 共享账号** | 🔴 违规 |
| **注册大量账号薅羊毛** | 🔴 严重违规 |

## 三、为什么"小团队自用"是合规的

技术上的合规性：

- **个人开发者**：OpenAI / Anthropic / Google 都欢迎 API 付费用户，账号用来做自己的项目完全合规
- **小团队**：使用 API Key 的人都是**账号所有人的同事**，实际还是"个人使用"
- **公司内部**：应该走 **Enterprise Account**（企业账户），不是个人自建

但**为什么企业账户更好**？

```
个人账户自建中转站：
  - 一个人付费，N 个人用（违规）
  - 一个人背负责任

企业账户：
  - 公司付费，所有员工用（合规）
  - OpenAI / Anthropic 提供官方集中管理
  - 价格反而更便宜（量大折扣）
```

> **如果你的"团队"是真正的公司**，建议直接申请 OpenAI / Anthropic 企业账户，**不要走自建中转站**。

## 四、API Key 安全：核心防线

### 风险分析

API Key 泄漏的 3 种途径：

```
1. 代码仓库泄露      → GitHub / Gitee 公开仓库
2. 配置文件泄露      → .env 文件上传到云
3. 服务器被入侵      → 弱密码、未修复的漏洞
```

### 4.1 代码仓库安全

```bash
# .gitignore 必须包含
.env
.env.*
config.local.yaml
*.pem
*.key
credentials.json

# 检查历史 commit
git log --all --full-history -- .env
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch .env" \
  --prune-empty --tag-name-filter cat -- --all

# 强制推送
git push origin --force --all
```

**核心原则**：

- API Key **永远不要**提交到 git
- 配置文件用 `.example` 后缀（如 `.env.example`）
- 真实配置通过环境变量或密钥管理服务注入

### 4.2 服务器密钥加密存储

#### new-api Token 加密

new-api 内部已用 bcrypt 哈希存储用户密码，Token 也加密。

#### kiro-rs 凭据加密

看第二章的 `devin-connect-credentials.js`，WindsurfAPI 用 **AES-256-GCM** 加密密码。

类似的方案可以自己实现：

```bash
# 用 age 加密敏感文件
# 安装
dnf install age -y

# 生成密钥
age-keygen -o ~/keys/ai-services.key

# 加密文件
age -r age1xxx... -o credentials.json.age credentials.json

# 解密
age -d -i ~/keys/ai-services.key credentials.json.age > credentials.json
```

### 4.3 最小权限原则

**每个 Token / API Key 只给最小必要权限**：

```sql
-- 普通开发 Token
INSERT INTO tokens (user_id, name, "key", "group", model_limits, allow_ips, quota) VALUES
  (5, 'dev-token', 'dev-xxx', 'default', 
   'claude-haiku-4-5-20251001',      -- 只允许便宜模型
   '192.168.1.0/24,10.0.0.5',         -- IP 白名单
   100);                              -- 额度限制

-- VIP Token（管理权限大）
INSERT INTO tokens (user_id, name, "key", "group", model_limits) VALUES
  (6, 'boss-token', 'boss-xxx', 'vip',
   'gpt-4o,claude-sonnet-4-5-20250929,claude-opus-4-5-20251101');
```

### 4.4 定期轮换

```bash
# 每 90 天轮换一次 API Key
# 1. 在 OpenAI 控制台创建新 Key
# 2. 在 new-api 替换
# 3. 验证新 Key 工作
# 4. 删除旧 Key
```

### 4.5 监控异常使用

```sql
-- 检测异常请求（比如短时间大量调用）
SELECT user_id, COUNT(*), MIN(created_at), MAX(created_at)
FROM logs
WHERE created_at > strftime('%s', 'now', '-1 hour')
GROUP BY user_id
HAVING COUNT(*) > 1000;  -- 1 小时内超过 1000 次请求

-- 检测异常 IP
SELECT ip, COUNT(DISTINCT user_id) AS distinct_users
FROM logs
WHERE created_at > strftime('%s', 'now', '-1 day')
GROUP BY ip
HAVING distinct_users > 5;  -- 一个 IP 关联多个用户
```

## 五、SSH 加固：服务器第一道门

### 5.1 强制密钥登录

```bash
# 1. 在本地生成密钥
ssh-keygen -t ed25519 -f ~/.ssh/ai-services

# 2. 上传公钥到服务器
ssh-copy-id -i ~/.ssh/ai-services.pub root@your-server

# 3. 服务器端禁用密码登录
sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# 4. 测试无密码登录
ssh -i ~/.ssh/ai-services root@your-server
```

### 5.2 修改默认端口

```bash
# SSH 端口从 22 改成 2222
sudo sed -i 's/#Port 22/Port 2222/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# 防火墙放行
sudo firewall-cmd --permanent --add-port=2222/tcp
sudo firewall-cmd --reload
```

### 5.3 Fail2Ban 防爆破

```bash
# 安装
dnf install fail2ban -y

# 配置
cat > /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
port = 2222
filter = sshd
logpath = /var/log/secure
maxretry = 3
bantime = 3600
EOF

# 启动
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

### 5.4 配置 SSH Config 简化连接

```bash
# ~/.ssh/config
Host ai-services
    HostName your-server-ip
    Port 2222
    User root
    IdentityFile ~/.ssh/ai-services
    ServerAliveInterval 60

# 使用
ssh ai-services
```

## 六、网络安全：Cloudflare 加固

### 6.1 启用 WAF

Cloudflare 控制台 → Security → WAF：

```
- 启用 Cloudflare Managed Ruleset
- 启用 OWASP Core Ruleset
- 敏感路径保护（如 /admin）
```

### 6.2 IP 白名单（可选）

如果中转站只服务特定地区，可以加 IP 规则：

```
# 只允许中国 IP（注意：可能误伤 Cloudflare IP）
(ip.geoip.country ne "CN") → Block

# 允许特定公司 IP
(ip.src in {203.0.113.0/24}) → Allow
(ip.src not in {203.0.113.0/24}) → Block
```

### 6.3 Rate Limiting

```
Cloudflare → Security → Rate Limiting Rules

规则示例：
- URL Path: /v1/*
- Rate: 100 requests / minute per IP
- Action: Block for 600 seconds
```

### 6.4 Bot Protection

```
Security → Bots → Bot Fight Mode 启用
```

### 6.5 隐藏服务器 IP

确保所有外部访问都通过 Cloudflare，VPS 真实 IP 不暴露：

```bash
# 测试：直接访问 VPS IP 应该被 Cloudflare 拦截或返回 403
curl -H "Host: api.your-domain.xyz" http://your-vps-ip/

# 应该看到 403 或 Cloudflare 拦截页面
```

如果直接 IP 还能访问，需要检查 Cloudflare 的配置：
- DNS 记录的代理状态必须开启（橙色云朵）
- VPS 上 nginx / iptables 应该禁止直接 IP 访问

## 七、数据隐私

### 7.1 对话内容是否被记录？

**回答**：**取决于上游**。

| 上游 | 是否记录提示词 |
|------|--------------|
| OpenAI API | ✅ 默认记录 30 天（用于安全审核）|
| Anthropic API | ✅ 默认记录 30 天 |
| Google Gemini API | ✅ 默认记录 |
| AWS Kiro | ✅ 可能记录 |
| Windsurf | ✅ 可能记录 |

**建议**：**不要在对话中放敏感信息**（密码、密钥、个人隐私数据）。

### 7.2 new-api 是否记录？

是的，new-api 在 `logs` 表里记录：

```sql
-- 你可以删除旧日志
DELETE FROM logs WHERE created_at < strftime('%s', 'now', '-30 days');

-- 永久关闭日志记录（不推荐，会失去审计能力）
UPDATE options SET value = 'false' WHERE key = 'LoggingEnabled';
```

### 7.3 自建中转站的隐私边界

```
数据流：
  用户 → 中转站 → 上游 AI API
  ↑        ↑           ↑
  你的      new-api      OpenAI
  Mac      Docker       服务器
```

**每个环节都看得到你的数据**：

- ✅ 你的 Mac：你自己看
- ⚠️ 中转站服务器：你和技术人员能看到（取决于 VPS 提供商）
- ⚠️ new-api Docker：技术上能看到，建议禁日志
- ⚠️ Cloudflare：CF 网络层能看到
- ⚠️ OpenAI / Anthropic：上游必然看到

**最稳妥的做法**：

1. 敏感信息用本地 AI（Ollama + Qwen 等）处理
2. 涉及客户数据 / 商业机密的对话用自建模型
3. 普通开发任务（写代码、文档）可以放心用云端 API

### 7.4 GDPR / 数据保护

如果你处理欧盟用户数据：

- **数据跨境**：服务器在硅谷，数据出境到美国（OpenAI），可能违反 GDPR
- **数据保留**：默认 30 天，需要配置删除策略
- **同意机制**：让用户知道对话会被发送到 OpenAI

**建议**：涉及欧盟用户的项目，**优先选择欧盟服务器**（AWS Frankfurt、爱尔兰等），AI API 用 EU 端点。

## 八、应急响应预案

### 8.1 账号被封

**症状**：OpenAI / Anthropic 返回 403 "Your account has been suspended"

**可能原因**：
- 1. 滥用检测（异常高频调用）
- 2. 余额耗尽
- 3. 违反 ToS（被举报或检测到分发）
- 4. 支付问题（信用卡过期）

**应急步骤**：

```bash
# 1. 立即禁用相关渠道
sqlite3 /opt/ai-services/new-api/data/one-api.db \
  "UPDATE channels SET status = 2 WHERE name = 'openai-primary';"

# 2. 切到备用渠道
# 所有请求自动转 backup-1、kiro-rs、windsurf

# 3. 联系 OpenAI 支持
# https://help.openai.com/

# 4. 准备新账号（如果有）

# 5. 审查使用模式，避免再次触发
```

### 8.2 Token 泄漏

**症状**：日志里出现异常 IP / 异常用户 / 用量激增

**应急步骤**：

```bash
# 1. 立即吊销泄漏的 Token
sqlite3 /opt/ai-services/new-api/data/one-api.db \
  "UPDATE tokens SET status = 2 WHERE name = 'leaked-token';"

# 2. 修改所有上游 Key
# OpenAI: https://platform.openai.com/api-keys → Revoke → Create new
# Anthropic: https://console.anthropic.com/ → Revoke

# 3. 在 new-api 中更新 Key
# 直接更新 channels 表的 key 字段

# 4. 重启所有服务
cd /opt/ai-services && docker compose restart

# 5. 调查泄漏途径
# - 代码仓库？
# - 服务器被入侵？
# - 截图误传？
```

### 8.3 服务器被入侵

**症状**：
- 异常 SSH 登录
- 异常进程
- 磁盘空间异常
- 出站流量异常

**应急步骤**：

```bash
# 1. 立即隔离
sudo iptables -I INPUT -p tcp --dport 2222 -j DROP
# 只保留自己的 IP 能 SSH

# 2. 检查入侵痕迹
sudo last -f /var/log/btmp         # 失败登录
sudo cat /var/log/secure | grep -i fail  # 认证失败
ps auxf                           # 进程树
sudo netstat -tulnp                # 监听端口

# 3. 备份关键数据（被入侵后第一时间备份）
cd /opt/ai-services
tar czf /tmp/emergency-backup.tar.gz \
  new-api/data/ kiro-rs/credentials.json \
  cliproxyapi/config.yaml windsurf-api/.env

# 4. 重装系统 + 恢复
# 这是最稳妥的做法，但耗时
```

### 8.4 数据丢失

**症状**：数据库损坏、文件丢失

**应急步骤**：

```bash
# 从最近的备份恢复
ls /backup/ai-services/
tar xzf /backup/ai-services/ai-services-20260722_030000.tar.gz -C /

# 重启服务
cd /opt/ai-services
docker compose restart
```

## 九、成本优化

### 9.1 估算月度成本

```
场景：5 人小团队，每天人均 100 次 AI 调用
     平均每次 2K input + 1K output

OpenAI API：
  - Sonnet 4.5：$3/M input + $15/M output
  - 5人 × 100次 × 30天 × 2K = 30M input
  - 5人 × 100次 × 30天 × 1K = 15M output
  - 成本：30×3 + 15×15 = $90 + $225 = $315/月

加上 Haiku（轻量任务）：$20/月

OpenAI 总计：$335/月 ≈ ¥2400/月
```

### 9.2 降本技巧

| 技巧 | 节省 |
|------|------|
| **Haiku 处理简单任务** | 60-80% |
| **缓存常用提示词** | 30-50% |
| **用 Kiro / Windsurf Free 套餐** | 80-90% |
| **设置 max_tokens 上限** | 10-30% |
| **批量请求合并** | 20-40% |

### 9.3 免费/低价方案

```
完全免费的方案（适合个人）：
  - kiro-rs：使用 AWS Builder ID 免费套餐
  - WindsurfAPI：Cascade Basic 每月 50 credits
  - Claude Code：免费 IDE（用 Kiro 套餐）

混合方案（适合小团队）：
  - 60% 请求走 Kiro / Windsurf（免费）
  - 30% 请求走 Haiku（便宜）
  - 10% 请求走 Sonnet（高质量）

成本：约 $30-80/月 ≈ ¥200-600/月
```

## 十、给团队的安全规范

### 10.1 团队使用手册

把安全规范写成文档：

```markdown
# AI 中转站使用规范

## 允许的用法
- 开发任务（写代码、调试、Code Review）
- 文档工作（写文档、翻译、总结）
- 学习研究（理解新概念、查资料）

## 禁止的用法
- ❌ 把 API Key 发给团队外的人
- ❌ 把对话内容发到公开渠道（含 API 输出）
- ❌ 处理客户隐私数据、商业机密
- ❌ 自动化脚本高频调用（每分钟 > 100 次）

## 配额限制
- 普通开发：每月 $50 等值
- 高级开发：每月 $200 等值
- 超过配额会被自动暂停

## 报告问题
- API Key 泄漏：立刻 @安全组
- 服务异常：在群里说
- 改进建议：发到 GitHub Issues
```

### 10.2 培训与监督

- **新成员入职培训**：1 小时讲清规范
- **月度审计**：查看用量异常的用户
- **季度复盘**：汇总问题、优化规则

## 十一、上游账号的"安全等级"

| 账号类型 | 风险 | 建议 |
|---------|------|------|
| **OpenAI 个人付费账户** | 低 | 自用没问题 |
| **OpenAI 企业账户** | 极低 | 团队用推荐 |
| **Anthropic 个人账户** | 低 | 自用没问题 |
| **AWS Builder ID (Kiro)** | 中 | 限制 token 用途 |
| **Windsurf Free** | 中 | 仅适合轻量任务 |
| **注册的"羊毛"账号** | 高 | 不推荐 |

## 十二、合规自查清单

部署完成后，定期检查：

```
□ 是否有任何 API Key 提交到 git
□ 是否所有 Token 都设置了 IP 白名单
□ 是否定期轮换 API Key（90 天）
□ 是否备份了所有关键数据
□ 是否给团队发了安全规范
□ 是否监控异常用量
□ 是否关闭了不必要的公网访问
□ SSH 是否禁用了密码登录
□ 是否启用了 Cloudflare WAF
□ 是否准备好应急响应预案
```

## 本篇总结（也是系列总结）

整个系列 7 篇覆盖了一个完整的 AI 中转站从 0 到 1：

```
01 架构与选型         ← 设计图 + 服务器选型
02 服务部署            ← Docker Compose 一键启动
03 网络打通            ← Cloudflare 加速
04 多渠道负载均衡     ← 故障转移 + 成本优化
05 客户端接入          ← 8 类工具集成
06 运维监控            ← 健康检查 + Token 刷新
07 合规与安全  ← 你在这里，最重要的一篇
```

最重要的几条原则：

1. **自用不商用** —— 这是红线
2. **API Key 是命脉** —— 加密存储、最小权限、定期轮换
3. **SSH 必须密钥登录** —— 别再用密码了
4. **所有流量走 Cloudflare** —— 隐藏真实 IP
5. **数据备份 7×24** —— 出事能恢复

如果只能记住一句话：

> **用中转站省下来的时间，应该花在写好代码上，而不是花在担心账号被封上。**

## 参考资料

- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)
- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- [Google AI Terms](https://ai.google.dev/terms)
- [SSH 安全加固指南](https://www.ssh.com/academy/ssh/security/)
- [Cloudflare WAF 文档](https://developers.cloudflare.com/waf/)
- [fail2ban 文档](https://github.com/fail2ban/fail2ban)

---

**全系列完结** 🎉

