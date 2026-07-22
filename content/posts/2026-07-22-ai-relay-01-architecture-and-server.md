---
title: "AI 中转站落地实践（一）：架构设计与服务器选型"
date: 2026-07-22
description: "系列第 1 篇：从问题出发，画清楚 AI API 反代中转站的整体架构，对比国内外主流服务器区域，给出 2C4G 配置的系统初始化全过程。"
tags: [AI 中转站, 反向代理, Docker, Cloudflare, 服务器选型]
draft: true
---

> **AI 中转站落地实践 · 系列目录**
>
> **01 架构与选型** · 02 服务部署 · 03 网络打通 · 04 渠道配置 · 05 客户端使用 · 06 运维监控 · 07 合规与安全

## 为什么要自建中转站？

国内开发者调用 OpenAI / Anthropic / Gemini 的官方 API，会同时踩到三个坑：

- **网络封锁**：`api.openai.com`、`api.anthropic.com` 在国内运营商侧被屏蔽
- **跨境延迟**：直连海外 API 的 RTT 通常 200ms+，流式响应卡顿
- **管理缺失**：团队共用 API Key 没有用量统计、没有审计、无法按人计费

**自建中转站** 不是为了转售（这违反所有上游服务 ToS），而是为了把以下三件事做好：

1. **统一入口**：一个 Base URL 解决所有上游 API
2. **用量治理**：按用户/项目/时间维度统计 token 消耗
3. **网络优化**：把跨境长链路变成 Cloudflare 加速后的短链路

> ⚠️ 本文所有方案仅供**个人 / 小团队内部研发**使用，严禁对外商业分发，详见系列第七篇《合规边界》。

## 整体架构

```
┌──────────────────────────────────────────────┐
│  中国开发者客户端（Claude Code / Cherry Studio） │
└────────────────────┬─────────────────────────┘
                     │ HTTPS（Cloudflare 加速）
                     ▼
┌──────────────────────────────────────────────┐
│  海外 VPS（硅谷 / 香港 / 日本）              │
│  ┌────────────────────────────────────────┐ │
│  │  new-api  :3000  （聚合网关）            │ │
│  │   - 用户管理、Token 生成、用量统计      │ │
│  │   - 渠道路由、负载均衡                  │ │
│  └────────────┬───────────────────────────┘ │
│               │                               │
│   ┌───────────┼───────────┬─────────────┐    │
│   ▼           ▼           ▼             ▼    │
│ CLIProxyAPI  kiro-rs   WindsurfAPI   （更多）│
│  :8317        :8990     :3003               │
│   │            │          │                  │
│   └────────────┼──────────┘                  │
└───────────────┼──────────────────────────────┘
                │ HTTPS
                ▼
   OpenAI / Anthropic / AWS Kiro / Devin
```

### 四个核心组件的职责

| 组件 | 职责 | 端口 |
|------|------|------|
| **new-api** | 统一网关、用户管理、Token 分发、用量统计 | 3000 |
| **CLIProxyAPI** | 协议转换（OpenAI ↔ Anthropic ↔ Gemini） | 8317 |
| **kiro-rs** | AWS Kiro 订阅转 Anthropic 兼容 API | 8990 |
| **WindsurfAPI** | Windsurf / Devin 订阅转多协议 API | 3003 |

### 流量链路详解

```
用户请求 → Cloudflare 边缘节点 → VPS 上 Docker 容器
   → new-api 鉴权 + 计费 → 路由到对应上游渠道
   → CLIProxyAPI / kiro-rs / WindsurfAPI
   → 真正调用 OpenAI / Anthropic / AWS API
   → 流式响应沿原路返回
```

全程 HTTPS，中间任意一环断了都有日志可查。

## 服务器选型

### 区域对比

| 区域 | 国内 → VPS 延迟 | AI 公司接入延迟 | IP 信誉 | 价格 |
|------|----------------|----------------|---------|------|
| 🇭🇰 **香港** | 20-50ms | 150ms+（绕太平洋）| ⚠️ 易被风控 | 中 |
| 🇯🇵 **日本** | 50-90ms | 100ms+ | ✅ 较好 | 中低 |
| 🇸🇬 新加坡 | 60-120ms | 80ms+ | ✅ 好 | 中 |
| 🇺🇸 **硅谷** | 130-200ms | **10-20ms**（同区）| ✅ 最佳 | 中 |
| 🇺🇸 弗吉尼亚 | 250-350ms | 80ms+ | ✅ 好 | 中 |

**本系列选硅谷**，理由：

- **AI 公司多在美西**：OpenAI 部分服务在 AWS us-west，Anthropic 也有美西节点
- **IP 信誉好**：硅谷机房是科技公司主战场，风控宽松
- **到上游 API 几乎是 0ms**：相同区域的服务器调用 API 延迟最低

> 国内 → 硅谷看似 200ms 慢，但因为到 AI 公司只有 20ms，**整体链路其实比 HK→美西 还快**。

### 配置推荐

| 配置项 | 推荐 | 说明 |
|--------|------|------|
| **CPU** | 2 核 | 反代是 I/O 密集型，2 核足够 |
| **内存** | 4 GB | 4 个 Docker 容器常驻约 1GB，留余量 |
| **系统盘** | 50 GB SSD | 日志和数据库占用 |
| **带宽** | 1-5 Mbps | 流式响应 100-300KB/s，2 人并发要 3-5Mbps |
| **操作系统** | Ubuntu 22.04 / TencentOS 3.3 | 主流 Linux 都行 |

### 推荐供应商

| 场景 | 推荐 | 价格 |
|------|------|------|
| 国内云厂商习惯 | 腾讯云 / 阿里云 硅谷节点 | ¥80-150/月 |
| 追求性价比 | Vultr 东京 / 新加坡 | $6-12/月 |
| 想稳定省心 | 阿里云香港 / UCloud 香港 | ¥32-80/月 |

## 系统初始化

以腾讯云硅谷节点的 TencentOS Server 3.3 为例（Ubuntu 22.04 流程相同）。

### 1. 服务器基础配置

```bash
# SSH 登录服务器
ssh root@your-server-ip

# 更新系统
dnf update -y        # RHEL/TencentOS 系
# 或
apt update && apt upgrade -y   # Debian/Ubuntu 系

# 设置时区
timedatectl set-timezone Asia/Shanghai
```

### 2. 安装 Docker

```bash
# 一键安装脚本
curl -fsSL https://get.docker.com | sh

# 启动 Docker
systemctl enable docker
systemctl start docker

# 验证
docker --version
docker compose version
```

### 3. 创建部署目录

```bash
mkdir -p /opt/ai-services/{cliproxyapi,kiro-rs,windsurf-api,new-api}
mkdir -p /opt/ai-services/cliproxyapi/data
mkdir -p /opt/ai-services/new-api/data
mkdir -p /opt/ai-services/windsurf-api/data
cd /opt/ai-services
tree -L 2   # 验证目录结构
```

目录结构应该是：

```
/opt/ai-services/
├── cliproxyapi/
│   └── data/
├── kiro-rs/
├── windsurf-api/
│   └── data/
└── new-api/
    └── data/
```

### 4. 安全加固

```bash
# 修改 root 密码
passwd

# 禁用密码登录（推荐用 SSH Key）
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# 配置防火墙（按需）
firewall-cmd --permanent --add-port=3000/tcp   # new-api
firewall-cmd --permanent --add-port=8317/tcp   # CLIProxyAPI
# 其余端口可以先不开，靠 Cloudflare Tunnel 访问
firewall-cmd --reload
```

## Cloudflare 加速（前置概念）

后续系列会详细讲，这里先建立概念。

### 为什么需要 Cloudflare？

| 直接访问海外 VPS | 通过 Cloudflare |
|----------------|-----------------|
| 国内 → VPS（200ms）| 国内 → CF 边缘（30ms）+ CF → VPS（内部，100ms）= 130ms |
| 容易断流 | 稳定 |
| 暴露 VPS IP | 隐藏 IP |
| 国内带宽拥堵 | Cloudflare BGP 优化 |

### 临时方案（推荐先试用）

不绑定域名也能用，CF 给每个隧道一个 `*.trycloudflare.com` 临时域名：

```bash
# 安装 cloudflared
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared-linux-amd64.deb

# 给一个端口启动临时隧道
cloudflared tunnel --url http://localhost:3000
```

启动后会得到类似 `https://xxx.trycloudflare.com` 的 URL，**重启会变**，但适合测试和小团队内部用。

## 本篇总结

这一篇搭好了地基：

- ✅ 明确了**自建中转站的目标边界**（自用提效，不是商业分发）
- ✅ 设计了**4 组件的整体架构**（new-api + 3 个上游）
- ✅ 选定了**硅谷 VPS** 作为部署区域
- ✅ 完成了**系统初始化**（Docker + 目录 + 安全）
- ✅ 了解了**Cloudflare 加速**的前置概念

下一篇《02 服务部署》会一步步把 4 个服务的 Docker 镜像跑起来，并完成 docker-compose 编排。

## 参考资料

- [new-api 官方仓库](https://github.com/QuantumNous/new-api/)
- [CLIProxyAPI 官方仓库](https://github.com/router-for-me/CLIProxyAPI)
- [kiro.rs 官方仓库](https://github.com/hank9999/kiro.rs)
- [WindsurfAPI 官方仓库](https://github.com/dwgx/WindsurfAPI)
- [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)

---

**下一步**：根据你实际选择的服务器和操作系统，初始化好环境，准备好 Docker，准备好之后告诉我，我们开始系列第二篇《服务部署》。