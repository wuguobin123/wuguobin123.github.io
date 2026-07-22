---
title: "AI 中转站落地实践（五）：客户端接入与多工具协同"
date: 2026-07-22
description: "系列第 5 篇：把 AI 中转站接到 Claude Code / Cherry Studio / CC Switch / Cursor / Cline / 手机端等主流客户端，覆盖 IDE 集成、GUI 客户端、命令行工具三大场景。"
tags: [AI 中转站, Claude Code, Cherry Studio, CC Switch, Cursor, IDE 集成]
draft: false
---

> **AI 中转站落地实践 · 系列目录**
>
> 01 架构与选型 · 02 服务部署 · 03 网络打通 · 04 渠道配置 · **05 客户端使用** · 06 运维监控 · 07 合规与安全

到这里，服务都跑起来了，渠道也配好了。**但最终用户怎么用？** 这一篇覆盖 8 类主流客户端的接入方法。

## 客户端全景图

```
                  ┌─────────────────┐
                  │   AI 中转站     │
                  │  (new-api)      │
                  │ api.your-       │
                  │  domain.xyz     │
                  └────────┬────────┘
                           │ HTTPS
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
   IDE 集成            GUI 客户端          命令行
   ┌─────────┐        ┌──────────┐       ┌────────┐
   │ Claude  │        │ Cherry   │       │ Claude │
   │ Code    │        │ Studio   │       │ Code   │
   ├─────────┤        ├──────────┤       ├────────┤
   │ Cursor  │        │ Chatbox  │       │ Aider  │
   ├─────────┤        ├──────────┤       ├────────┤
   │ Cline   │        │ LobeChat │       │ Open   │
   │ (VSCode)│        │          │       │ Codex  │
   └─────────┘        └──────────┘       └────────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                  ┌─────────────────┐
                  │   手机端         │
                  │  Cherry Studio  │
                  │   (iOS/Android) │
                  └─────────────────┘
```

## 一、Claude Code（命令行首选）

Claude Code 是 Anthropic 官方的命令行工具，原生支持 Anthropic API 协议。

### 安装

```bash
# macOS
brew install node
npm install -g @anthropic-ai/claude-code

# 验证
claude --version
```

### 配置方式 A：环境变量（推荐）

写到 `~/.zshrc` 或 `~/.bashrc`：

```bash
# 中转站地址
export ANTHROPIC_BASE_URL="https://api.your-domain.xyz"
export ANTHROPIC_AUTH_TOKEN="new-api生成的user-token"

# 可选：自定义默认模型
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5-20250929"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5-20251001"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-sonnet-4-5-20250929"

# 应用更改
source ~/.zshrc
```

### 配置方式 B：Claude Code settings.json

```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.your-domain.xyz",
    "ANTHROPIC_AUTH_TOKEN": "new-api生成的user-token",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-20250929",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001"
  },
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

> ⚠️ 注意：Claude Code 优先用 `settings.json` 里的 env，覆盖 shell 环境变量。

### 使用方式

```bash
# 交互模式
claude

# 一次性命令
claude --print "用一句话介绍你自己"

# 指定模型
claude --model claude-sonnet-4-5-20250929
claude --model claude-haiku-4-5-20251001

# 带 thinking 模式（深度推理）
claude --model claude-sonnet-4-5-20250929-thinking

# 项目目录中使用
cd ~/my-project && claude

# 危险操作自动确认（慎用）
claude --dangerously-skip-permissions
```

### 在项目中用 Claude Code

```bash
cd /path/to/your/project

# Claude Code 自动读取项目结构
claude

# 你可以说："重构这个函数"、"添加单元测试"、"解释这段代码"
```

## 二、Cherry Studio（GUI 客户端首选）

Cherry Studio 是国产开源的多模型 GUI 客户端，UI 美观、支持多模型，特别适合非命令行用户。

### 安装

```bash
# macOS
brew install --cask cherry-studio

# 或下载 https://github.com/CherryHQ/cherry-studio/releases
```

### 配置 OpenAI 兼容服务

打开 Cherry Studio → 设置 → 模型服务 → 添加：

```
服务商:       OpenAI 兼容
名称:         中转站 (随便起)
Base URL:    https://api.your-domain.xyz/v1
API Key:     new-api生成的user-token
模型:        gpt-4o, claude-sonnet-4-5-20250929, ...
```

### 配置 Anthropic 协议

Cherry Studio 也支持 Anthropic 原生协议：

```
服务商:       Anthropic
Base URL:    https://api.your-domain.xyz
API Key:     new-api生成的user-token
模型:        claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001
```

### 多模型切换

在对话界面可以随时切换不同模型：

- 简单问答：选 `claude-haiku-4-5-20251001`（便宜、快速）
- 复杂推理：选 `claude-sonnet-4-5-20250929-thinking`
- 长文档：选 `claude-sonnet-4-5-20250929`

### 适合场景

- ✅ 不熟悉命令行的同事
- ✅ 需要在 GUI 里管理多个对话
- ✅ 偶尔用 AI 写文档、聊天

## 三、CC Switch（多渠道切换工具）

CC Switch 是 macOS 上的工具，专为多 Claude API 切换设计。

### 安装

```bash
brew tap farion1231/ccswitch
brew install --cask cc-switch

# 或下载 https://github.com/farion1231/cc-switch/releases
```

### 添加新渠道

打开 CC Switch → 左下角 "+" → 填入：

```
名称:    中转站 / new-api
类型:    Claude
Base URL: https://api.your-domain.xyz
API Key: new-api生成的user-token
```

CC Switch 会写入 `~/.claude/settings.json`，切换时即时生效。

### 切换工作流

CC Switch 的核心价值：**一套配置，多种 AI 后端，一键切换**。

```
场景 1：默认用中转站
  切换到 [中转站 / new-api]

场景 2：海外出差直连官方
  切换到 [Claude Official]

场景 3：测试某个新渠道
  切换到 [测试供应商]

场景 4：临时降级到便宜模型
  切换到 [Groq / OpenRouter]
```

### 配置文件位置

```bash
# CC Switch 数据库（包含所有渠道配置）
~/.cc-switch/cc-switch.db

# 当前激活的渠道写入这里
~/.claude/settings.json
```

CC Switch 还支持**健康检查**、**用量统计**、**MCP 管理**等高级功能。

## 四、Cursor（AI IDE）

Cursor 是基于 VS Code 的 AI 编辑器，深度集成 AI 编程。

### 配置方法

`Cursor Settings` → `Models` → 展开 `API Keys`：

```
OpenAI API Key: new-api生成的user-token
Override OpenAI Base URL: https://api.your-domain.xyz/v1
```

或者环境变量：

```bash
export OPENAI_API_KEY="new-api生成的user-token"
export OPENAI_BASE_URL="https://api.your-domain.xyz/v1"
```

### 注意事项

Cursor 默认用 OpenAI 协议。`claude-*` 模型在 Cursor 里要走 Anthropic 配置：

```
Cursor Settings → Models → Anthropic:
API Key: new-api生成的user-token
Override Base URL: https://api.your-domain.xyz
```

> 注意：Cursor 部分高级功能（Composer、Tab）可能需要特殊兼容。

## 五、Cline（VS Code 插件）

Cline 是 VS Code 的 AI 编程插件，开源免费，支持多种模型。

### 安装

VS Code → 扩展 → 搜索 "Cline" → 安装

### 配置

Cline 设置 → API Provider：

```
API Provider:     OpenAI Compatible
Base URL:         https://api.your-domain.xyz/v1
API Key:          new-api生成的user-token
Model ID:         claude-sonnet-4-5-20250929
```

### 适合场景

- 不愿意换 IDE 的 VS Code 用户
- 需要在原 VS Code 生态里用 AI

## 六、Aider（命令行 AI 编程工具）

Aider 是另一个流行的命令行 AI 编程工具，支持 git 集成。

### 安装

```bash
pip install aider-chat

# 配置
export OPENAI_API_BASE="https://api.your-domain.xyz/v1"
export OPENAI_API_KEY="new-api生成的user-token"
```

### 使用

```bash
# 在项目目录里
cd ~/my-project
aider

# 直接编辑文件
aider src/main.py "添加错误处理"
```

## 七、Chatbox（轻量 GUI）

Chatbox 是另一个支持多模型的 GUI 客户端，比 Cherry Studio 更轻量。

### 安装

```bash
brew install --cask chatbox
```

### 配置

设置 → 自定义提供商：

```
类型:        OpenAI
名称:        中转站
Base URL:   https://api.your-domain.xyz/v1
API Key:    new-api生成的user-token
模型:       gpt-4o, claude-sonnet-4-5-20250929
```

## 八、手机端访问

### 方案 A：Cherry Studio 移动版

iOS / Android 都有 Cherry Studio 移动版。

### 方案 B：Termux + Claude Code（Android）

```bash
# 在 Termux 里
pkg install node
npm install -g @anthropic-ai/claude-code

export ANTHROPIC_BASE_URL="https://api.your-domain.xyz"
export ANTHROPIC_AUTH_TOKEN="new-api生成的user-token"

claude
```

### 方案 C：SSH 到 VPS 直接用

手机 SSH 客户端（Termius / JuiceSSH）连到服务器：

```bash
ssh root@your-server
claude --print "用一句话总结"
```

### 方案 D：Web 端

如果上游支持 WebSocket，可以用 Web 客户端（如 Open WebUI、Lobe Chat）：

```bash
# Docker 部署 Open WebUI（推荐）
docker run -d --name open-webui \
  -p 8080:8080 \
  -e OPENAI_API_BASE_URL=https://api.your-domain.xyz/v1 \
  -e OPENAI_API_KEYS=new-api生成的user-token \
  ghcr.io/open-webui/open-webui:main
```

访问 `http://你的服务器:8080`，得到一个类似 ChatGPT 的 Web 界面。

## 九、企业级：HTTP API 直接调用

如果你的项目要集成 AI，用 HTTP API 最直接：

### curl 调用示例

```bash
# OpenAI 协议
curl -X POST https://api.your-domain.xyz/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer new-api-token" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'

# Anthropic 协议
curl -X POST https://api.your-domain.xyz/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: new-api-token" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Python SDK 示例

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.your-domain.xyz/v1",
    api_key="new-api-token"
)

response = client.chat.completions.create(
    model="claude-sonnet-4-5-20250929",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content, end="")
```

### Anthropic SDK 示例

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://api.your-domain.xyz",
    api_key="new-api-token"
)

message = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)
print(message.content[0].text)
```

## 十、客户端对比

| 客户端 | 适合谁 | 配置难度 | 高级功能 |
|--------|--------|---------|----------|
| **Claude Code** | 命令行党、程序员 | ⭐ | MCP、Sub-agent |
| **Cherry Studio** | 普通用户、文档写作 | ⭐ | 文档助手、画板 |
| **CC Switch** | 多渠道切换 | ⭐⭐ | 用量统计、MCP |
| **Cursor** | 重度 AI IDE 用户 | ⭐⭐ | Composer、Tab |
| **Cline** | VS Code 老用户 | ⭐⭐ | Plan/Act 模式 |
| **Aider** | Git 工作流 | ⭐⭐ | 自动 commit |
| **Chatbox** | 极简需求 | ⭐ | 跨设备同步 |
| **手机端** | 通勤、出差 | ⭐⭐ | 语音输入 |

## 十一、给团队分发的最佳实践

### 1. 不同角色用不同 Token

```sql
-- 普通开发（默认分组，用便宜渠道）
INSERT INTO tokens (user_id, name, "key", "group") VALUES
  (5, 'dev-zhangsan-token', 'dev-zhangsan-xxx', 'default');

-- 高级开发（VIP 分组，用稳定渠道）
INSERT INTO tokens (user_id, name, "key", "group") VALUES
  (6, 'dev-boss-token', 'dev-boss-xxx', 'vip');
```

### 2. 统一配置文件模板

给团队一个**配置模板**，他们只需要改 `API_KEY`：

```bash
# ~/.zshrc

# 中转站配置（请勿修改 base_url）
export ANTHROPIC_BASE_URL="https://api.your-domain.xyz"
export ANTHROPIC_AUTH_TOKEN="在此填入你的个人 token"

# 模型偏好
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5-20250929"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5-20251001"
```

### 3. 给前端/移动端的 API Key

如果是给前端应用用的 Key：

```sql
-- 前端专用：限制 IP 白名单
INSERT INTO tokens (user_id, name, "key", "group", allow_ips) VALUES
  (10, 'frontend-token', 'frontend-xxx', 'frontend', '192.168.1.0/24');

-- 只允许特定模型
UPDATE tokens SET model_limits_enabled = 1,
                 model_limits = 'gpt-4o-mini,claude-haiku-4-5-20251001'
WHERE name = 'frontend-token';
```

## 本篇总结

本篇覆盖了 8 类客户端的接入：

- ✅ **Claude Code**：环境变量 + settings.json
- ✅ **Cherry Studio**：GUI 首选
- ✅ **CC Switch**：多渠道切换
- ✅ **Cursor / Cline / Aider**：IDE 集成
- ✅ **Chatbox**：轻量 GUI
- ✅ **手机端**：Termux / SSH / Web
- ✅ **HTTP API**：curl + Python SDK
- ✅ **团队分发**：按角色 + 限速 + IP 白名单

下一篇《06 运维监控》会讲**怎么监控整个中转站的健康状态、用量趋势、异常告警**，以及 Token 失效后的恢复流程。

## 参考资料

- [Claude Code 官方文档](https://docs.anthropic.com/en/docs/claude-code)
- [Cherry Studio GitHub](https://github.com/CherryHQ/cherry-studio)
- [CC Switch GitHub](https://github.com/farion1231/cc-switch)
- [Cursor 官方文档](https://docs.cursor.com)
- [Cline VSCode 插件](https://github.com/cline/cline)
- [Aider GitHub](https://github.com/Aider-AI/aider)
- [Open WebUI](https://github.com/open-webui/open-webui)

---
