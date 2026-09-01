---
title: "实战踩坑录 02 · macOS 桌面 App 部署：DMG 文件名大小写、Gatekeeper、MLX 后端自动选择"
date: "2026-08-08"
description: "下载页文档写小写、release 是大写；非公证 .app 首次启动被 Gatekeeper 拦；Apple Silicon 选错 DMG 会跑 CPU 而非 MLX。三个坑的根因和绕路办法。"
tags: [macOS, 部署, DMG, Gatekeeper, MLX, Apple Silicon]
draft: true
---

## 一、症状

M1 Pro / 16GB 上把 voicebox 跑起来，三个连环坑：

1. **下载链接 404**：`https://github.com/.../Voicebox_0.5.0_aarch64.dmg` 不存在，文档里写的是 `voicebox_aarch64.app.tar.gz`。
2. **装完双击没反应**：`.app` 已经拷到 `/Applications`，启动台里点图标，弹个「无法打开，因为它来自身份不明的开发者」就没了。
3. **健康检查 `gpu_available: false`**：`backend_type` 是 `PYTORCH` 而不是 `MLX`，Mac 上跑 CPU 模式。

三个坑分别对应：release 资产命名、Gatekeeper、Apple Silicon 架构选择。

---

## 二、根因 & 修复

### 坑 1：文档与 release 资源命名不一致

文档 `docs/content/docs/overview/installation.mdx` 写的是小写 `voicebox_aarch64.app.tar.gz`，但 GitHub release 0.5.0 上传的资产是大写 `Voicebox_0.5.0_aarch64.dmg`。

```bash
# 文档里推荐的路径（小写）→ 404
$ curl -L -o voicebox_aarch64.app.tar.gz \
    https://github.com/.../releases/download/v0.5.0/voicebox_aarch64.app.tar.gz
HTTP 404

# 实际路径（大写 + DMG）→ 200
$ curl -L -o Voicebox_0.5.0_aarch64.dmg \
    https://github.com/.../releases/download/v0.5.0/Voicebox_0.5.0_aarch64.dmg
200 OK (~538 MB)
```

**根因**：发布时没把 release 资产名同步到文档。GitHub release 资产名是大小写敏感的。

**绕路**：

- 永远先 `curl -I` 看 release assets 实际清单，再决定下载哪个，不要直接照文档抄。
- 文档里只写相对路径或用 GitHub API 动态拼：`/releases/download/v{VERSION}/{NAME}-{ARCH}.{ext}`。
- 安装脚本里加一层 `if [[ ! -f file ]]; then try_alt_name; fi`。

### 坑 2：非公证 .app 被 Gatekeeper 拦截

首次从 DMG 拷过去的 `.app` 没经过 Apple 公证，quarantine 属性还在。macOS 默认行为：

1. 右键 → 打开：会弹一次「仍要打开」按钮。
2. 双击：直接被静默拦截，图标闪一下就消失。

```bash
$ ls -l /Applications/Voicebox.app/Contents/MacOS/
-rwxr-xr-x@ 1 user staff  voicebox-server        # '@' = 有扩展属性（quarantine）
-rwxr-xr-x@ 1 user staff  voicebox-mcp
```

**根因**：`@` 标记的扩展属性 `com.apple.quarantine` 表明这个文件是从网络下载的、没经过 `xcrun notarytool` 验证。

**绕路**（按推荐度排序）：

```bash
# 方法 A（最稳）：右键 → 打开 → 「仍要打开」
# 优点：不丢 quarantine 隔离；缺点：每次新装都要点

# 方法 B：xattr 去掉 quarantine（DMG 内安装场景下推荐）
$ xattr -dr com.apple.quarantine /Applications/Voicebox.app

# 方法 C：企业内部分发，建议过公证
$ xcrun notarytool submit Voicebox_0.5.0_aarch64.dmg \
    --apple-id "$APPLE_ID" --team-id "$TEAM_ID" \
    --password "$APP_PW" --wait
$ xcrun stapler staple Voicebox_0.5.0_aarch64.dmg
```

社区项目通常走方法 B；商业项目必须走方法 C。

### 坑 3：选错架构 DMG → 跑 CPU 而非 MLX

如果一不小心下成 Intel 版（`x86_64`），Rosetta 翻译能跑，但 `gpu_available: false`：

```json
{
  "status": "healthy",
  "backend_type": "PYTORCH",   // 期望 "MLX"
  "backend_variant": "cpu",    // 期望 "mlx" 或 "mps"
  "gpu_available": false       // 期望 true
}
```

**根因**：Apple Silicon 上跑 x86_64 后端，PyTorch 检测不到 MPS 后端（Metal Performance Shaders），自动 fallback 到 CPU。

**绕路**：

```bash
# 1. 确认架构
$ uname -m
arm64   # Apple Silicon
x86_64  # Intel 或 Rosetta

# 2. 下载对应 DMG
$ curl -L -o Voicebox_0.5.0_aarch64.dmg https://.../Voicebox_0.5.0_aarch64.dmg
#                                                         ^^^^^^^^ 一定要带 aarch64

# 3. 启动后看健康检查的 backend_type
$ curl -s http://127.0.0.1:17493/health | python3 -m json.tool
# 期望 "MLX" 或 "mlx" / "mps"
```

App 内首次启动会通过 `backend/utils/platform_detect.py` 自动选 MLX（Metal + Neural Engine），但前提是 `.app` 本身是 aarch64 构建。

---

## 三、可复用清单 · macOS 桌面 App 部署

跑任何新的桌面 App 之前先过一遍：

| 检查 | 命令 | 期望 |
|---|---|---|
| 架构 | `uname -m` | Apple Silicon → `arm64` |
| 磁盘空间 | `df -h ~` | ≥ 10 GB |
| Xcode CLT | `xcode-select -p` | 有输出 |
| 端口空闲 | `lsof -i :<port>` | 空 |
| DMG 大小写 | `curl -I <url>` | 200 |
| 启动后门 | `curl <port>/health` | `status: "healthy"` |
| 后端类型 | 同上 | 含 `MLX` / `mlx` / `mps` |

如果「装完双击没反应」，先看 `~/Library/Logs/<app>/server.log` 而不是 Console.app——日志路径在每个 app 的 `backend/config.py` 里自定义过。

---

## 四、相关坑

- [[2026-08-08-pitfalls-08-builtin-skills-vs-docker-volume]] · macOS 本地部署踩完 macOS 自身的 Gatekeeper，服务端的「内置资源没跟 image 更新」是 Docker 卷对应的同构问题：第一次挂载后不再同步。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · 真正想给桌面 App 加能力，后端是用统一注册模式（参见第 11 篇）而不是各 app 自己搞一套。