---
title: "AI 中转站落地实践（三）：用 Cloudflare Tunnel 打通公网访问"
date: 2026-07-22
description: "系列第 3 篇：从国内访问海外 VPS 的网络瓶颈讲起，详细讲解 Cloudflare Tunnel 临时隧道和 Named Tunnel 长期方案，含 DNS / HTTPS / 自动续期 / systemd 自启。"
tags: [AI 中转站, Cloudflare, Tunnel, 网络加速, HTTPS, 内网穿透]
draft: true
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · **03 网络打通** · 04 渠道配置 · 05 客户端使用 · 06 运维监控 · 07 合规与安全

## 为什么需要"网络打通"？

把 4 个服务跑起来只是第一步。真正难的是：**让国内开发者能稳定访问**。

### 直接连海外 VPS 的问题

```
国内开发者 → 腾讯云硅谷 VPS（43.173.x.x）
   ↓
   1. 跨境链路：要走 BGP → 国际出口 → 海底光缆 → 美国机房
   2. 国内运营商 QoS：高峰期跨境带宽拥堵
   3. 丢包率高：晚高峰 1-5% 丢包（流式响应会卡）
   4. VPS IP 暴露：被 AI 公司识别后可能风控
```

实测：直接 curl 一个 VPS 上的 API，**晚高峰 95 分位延迟 800ms+**。

### Cloudflare 是怎么解决的

```
国内开发者 → Cloudflare 边缘节点（HK / 东京 / 上海）
                  ↓ CF 内部专线（比公网稳定 5-10 倍）
              Cloudflare 边缘节点（San Jose）
                  ↓
              你的 VPS（隐藏在 CF 网络后）
```

- **隐藏 VPS 真实 IP**：AI 公司只看到 Cloudflare IP
- **绕过运营商拥堵**：CF 内部走 ASRank 顶级骨干网
- **自动 HTTPS**：CF 提供免费证书，自动续期
- **DDoS 防护**：免费版就有基础防护

## 两条路线选择

| 方案 | 适用场景 | 域名 | 价格 |
|------|---------|------|------|
| **Quick Tunnel** | 自用 / 测试 / 小团队 | ❌ 用 `*.trycloudflare.com` 临时域名 | 免费 |
| **Named Tunnel** | 长期使用 / 团队分享 | ✅ 用自己的域名 | ¥70/年域名 |

**建议**：

- 先用 Quick Tunnel 验证整套链路
- 稳定后花 ¥70 买个 `.xyz` / `.top` 域名升级到 Named Tunnel

## 方案 A：Quick Tunnel（5 分钟搞定）

### 1. 安装 cloudflared

```bash
# TencentOS / RHEL 系（不能直接 dpkg，需要手动解压）
cd /tmp
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb

# 创建临时目录解压
mkdir cf-extract && cd cf-extract
ar x ../cloudflared.deb              # ar 命令可能需要 binutils
tar -xf data.tar.gz
cp usr/local/bin/cloudflared /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Ubuntu / Debian 系（一行搞定）
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb

# 验证
cloudflared --version
```

### 2. 启动 4 个临时隧道

每个服务一个隧道，每个隧道一个临时域名。

```bash
# 写一个启动脚本
cat > /opt/ai-services/start-quick-tunnels.sh << 'EOF'
#!/bin/bash

mkdir -p /opt/ai-services/logs

# new-api（统一入口）
nohup cloudflared tunnel --no-autoupdate --url http://localhost:3000 \
  > /opt/ai-services/logs/tunnel-newapi.log 2>&1 &

# CLIProxyAPI
nohup cloudflared tunnel --no-autoupdate --url http://localhost:8317 \
  > /opt/ai-services/logs/tunnel-cli.log 2>&1 &

# kiro-rs
nohup cloudflared tunnel --no-autoupdate --url http://localhost:8990 \
  > /opt/ai-services/logs/tunnel-kiro.log 2>&1 &

# WindsurfAPI
nohup cloudflared tunnel --no-autoupdate --url http://localhost:3003 \
  > /opt/ai-services/logs/tunnel-windsurf.log 2>&1 &

echo "Tunnels starting, waiting 30s..."
sleep 30
echo "Done. Check logs in /opt/ai-services/logs/"
EOF
chmod +x /opt/ai-services/start-quick-tunnels.sh
bash /opt/ai-services/start-quick-tunnels.sh
```

### 3. 获取临时域名

```bash
# 每个日志文件里都有 URL
for svc in newapi cli kiro windsurf; do
  echo "--- $svc ---"
  grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" \
    /opt/ai-services/logs/tunnel-$svc.log | head -1
done
```

输出类似：

```
newapi:   https://hockey-platforms-may-work.trycloudflare.com
cli:       https://travelers-populations-publicity-implementation.trycloudflare.com
kiro:      https://instrumentation-markets-teachers-surround.trycloudflare.com
windsurf:  https://flame-continuing-promotions-tops.trycloudflare.com
```

**记下这些 URL**，后面客户端配置要用。

### 4. 验证 Quick Tunnel

```bash
# 从你的 Mac 访问（应该 200）
curl -sI https://hockey-platforms-may-work.trycloudflare.com/
```

### 5. Quick Tunnel 的限制

- ❌ **URL 不稳定**：每次重启 cloudflared 会换地址
- ❌ **不能用于生产**：URL 变化会影响客户端配置
- ❌ **Cloudflare 限流**：Quick Tunnel 适合低流量自用

如果想长期稳定，**升级到 Named Tunnel**。

## 方案 B：Named Tunnel（长期方案）

### 1. 准备工作

- 一个域名（推荐 `.xyz` 或 `.top`，首年 ¥7-15）
- 一个 Cloudflare 账号（免费）

### 2. 把域名接入 Cloudflare

1. 注册 https://dash.cloudflare.com
2. 添加域名 → 选择 Free 计划
3. Cloudflare 会给你两个 NS 记录
4. 去你的域名注册商，把 NS 改为 Cloudflare 的
5. 等待 DNS 生效（通常几分钟到几小时）

### 3. 创建 Named Tunnel

```bash
# 登录（会打开浏览器授权）
cloudflared tunnel login

# 创建隧道
cloudflared tunnel create ai-relay
```

这会生成：

- `~/.cloudflared/cert.pem`（账户证书）
- `~/.cloudflared/<TUNNEL_ID>.json`（隧道凭据）

记下 `<TUNNEL_ID>`。

### 4. 配置文件

```yaml
# ~/.cloudflared/config.yml
tunnel: <你的TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json

ingress:
  # new-api 统一入口
  - hostname: api.your-domain.xyz
    service: http://localhost:3000
  
  # kiro-rs
  - hostname: kiro.your-domain.xyz
    service: http://localhost:8990
  
  # CLIProxyAPI
  - hostname: cli.your-domain.xyz
    service: http://localhost:8317
  
  # WindsurfAPI
  - hostname: windsurf.your-domain.xyz
    service: http://localhost:3003
  
  # 健康检查（必须保留）
  - service: http_status:404
```

### 5. DNS 记录

Cloudflare 控制台 → DNS → 添加 4 条 CNAME：

```
类型:    CNAME
名称:    api
目标:    <TUNNEL_ID>.cfargotunnel.com
代理:    ✅ 已代理（橙色云朵）

类型:    CNAME
名称:    kiro
目标:    <TUNNEL_ID>.cfargotunnel.com
代理:    ✅ 已代理

类型:    CNAME
名称:    cli
目标:    <TUNNEL_ID>.cfargotunnel.com
代理:    ✅ 已代理

类型:    CNAME
名称:    windsurf
目标:    <TUNNEL_ID>.cfargotunnel.com
代理:    ✅ 已代理
```

### 6. 启动隧道

```bash
# 测试
cloudflared tunnel run ai-relay

# 安装为系统服务（开机自启）
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# 查看状态
sudo systemctl status cloudflared
```

### 7. 验证 Named Tunnel

```bash
# 现在用固定域名访问
curl -sI https://api.your-domain.xyz/
# 应该返回 200 或 404（new-api 根路径）
```

## 4 个服务的内外地址映射

部署完成后，每个服务有两个地址：

| 服务 | 内部地址（同机器） | 外部地址（用户访问）|
|------|------------------|------------------|
| new-api | `http://localhost:3000` | `https://api.your-domain.xyz` |
| CLIProxyAPI | `http://localhost:8317` | `https://cli.your-domain.xyz` |
| kiro-rs | `http://localhost:8990` | `https://kiro.your-domain.xyz` |
| WindsurfAPI | `http://localhost:3003` | `https://windsurf.your-domain.xyz` |

**关键原则**：

- **同机器的服务互调用**用 `http://服务名:端口`（Docker 网络内部）
- **用户访问**用 `https://域名`（Cloudflare 加速）

### new-api 配置上游渠道时填什么

```sql
-- 在 new-api 中添加渠道
INSERT INTO channels (type, name, base_url, "key", models) VALUES
  (0, 'openai',    'http://cliproxyapi:8317/v1',  'sk-cliproxy-default-key-2026', 'gpt-4o,claude-sonnet-4-5-20250929'),
  (14, 'kiro',      'http://kiro-rs:8990',         'sk-kiro-rs-default-key-2026',   'claude-sonnet-4-5-20250929'),
  ...
```

> 注意：内部地址用 `cliproxyapi`（Docker 服务名）而不是 `localhost`。

### 用户端配置

```bash
# Claude Code 用 new-api 的对外域名
export ANTHROPIC_BASE_URL="https://api.your-domain.xyz/v1"
export ANTHROPIC_AUTH_TOKEN="new-api生成的user-token"
```

```bash
# 直接用 kiro-rs（不通过 new-api）
export ANTHROPIC_BASE_URL="https://kiro.your-domain.xyz"
export ANTHROPIC_AUTH_TOKEN="sk-kiro-rs-default-key-2026"
```

## Cloudflare 安全加固

### 1. SSL/TLS 加密模式

> Cloudflare 控制台 → SSL/TLS → **Full (Strict)**

而不是 "Full" 或 "Flexible"。确保 Cloudflare 到 VPS 的连接也加密。

### 2. 启用 HTTP/3 (QUIC)

> Speed → Network → **HTTP/3 (QUIC) 启用**

对流式响应特别友好。

### 3. 启用 Brotli 压缩

> Speed → Optimization → **Brotli 启用**

API 响应大多 JSON，压缩后能减少 60%+ 流量。

### 4. 配置防火墙规则

> Security → WAF → Custom Rules

可以加规则限制只允许中国 IP 访问（如果只服务国内）：

```
(ip.geoip.country ne "CN") and (ip.geoip.country ne "HK")
```

注意：这可能过于激进，建议先用其他方法。

## 隧道性能监控

### 查看 cloudflared 状态

```bash
# 系统服务方式
sudo systemctl status cloudflared

# 查看日志
sudo journalctl -u cloudflared -f

# 或 Quick Tunnel 方式
tail -f /opt/ai-services/logs/tunnel-newapi.log
```

### 测试延迟

```bash
# 从国内测延迟
for i in 1 2 3; do
  curl -o /dev/null -s -w "Time: %{time_total}s\n" \
    https://api.your-domain.xyz/v1/models \
    -H "Authorization: Bearer test"
done
```

期望：50-150ms（高峰期可能到 300ms）。

## 故障排查

### Q1: Quick Tunnel 502 Bad Gateway

```bash
# 原因：cloudflared 连接不上源服务
curl -s http://localhost:3000/   # 先验证本地服务
```

可能：
- 本地服务挂了 → `docker compose restart new-api`
- 端口写错 → 检查启动命令

### Q2: Named Tunnel "no such host"

```bash
# 检查 DNS 解析
nslookup api.your-domain.xyz

# 检查 cloudflared 状态
sudo systemctl status cloudflared
```

### Q3: 证书错误

Cloudflare 自动管证书，无需手动操作。如果浏览器报证书错误：

- 检查 SSL/TLS 模式是不是 Full (Strict)
- 检查 cloudflared 是否正常运行

### Q4: 连接慢

```bash
# 测试 Cloudflare 边缘延迟
curl -o /dev/null -s -w "Connect: %{time_connect}s, Total: %{time_total}s\n" \
  https://api.your-domain.xyz/

# 对比直连
curl -o /dev/null -s -w "Connect: %{time_connect}s, Total: %{time_total}s\n" \
  http://43.173.x.x:3000/
```

如果 Cloudflare 比直连慢：
- 检查 VPS IP 是否被运营商 QoS
- 换 Cloudflare 边缘节点

## 备份与恢复

### 备份 Tunnel 配置

```bash
# cloudflared 配置
tar czf tunnel-config-backup.tar.gz ~/.cloudflared/

# 恢复
tar xzf tunnel-config-backup.tar.gz -C ~/
```

### 备份 Cloudflare DNS

Cloudflare 控制台 → DNS → Records → **Export** 按钮可以导出 BIND 格式。

## 本篇总结

本篇解决了"国内访问"这个最关键的问题：

- ✅ **Cloudflare 加速**：把 200ms+ 的跨境延迟优化到 50-150ms
- ✅ **Quick Tunnel**：5 分钟搞定，零成本，适合自用
- ✅ **Named Tunnel**：长期稳定，绑定自己域名
- ✅ **内外地址分离**：服务间用 Docker 内部地址，用户访问用 HTTPS 域名
- ✅ **Cloudflare 加固**：SSL/HTTP3/Brotli

下一篇《04 渠道配置细节》会讲**如何高效管理多渠道**（OpenAI / Anthropic / Kiro / Windsurf），包括**负载均衡、故障转移、限速**等高级用法。

## 参考资料

- [Cloudflare Tunnel 官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [cloudflared GitHub Releases](https://github.com/cloudflare/cloudflared/releases)
- [Cloudflare 域名注册](https://www.cloudflare.com/products/registrar/)

---
