---
title: "实战踩坑录 03 · 多租户前端 demo 用户 vs 后端 seed 用户：401 ACTOR_NOT_FOUND 全链路"
date: "2026-08-08"
description: "前端 demo 账号用 sales-101/agent-001，后端只 seed tenant-a 的真实演员。登录即 401 但前端只显示『Unauthorized』——根因是错误信封没解开、auth bootstrap 有竞态、CSS 还把页面挤成一条窄缝。"
tags: [多租户, 前端, 鉴权, Bootstrap, FastAPI, React]
draft: true
---

## 一、症状

整套前端连后端，登录就失败。表现是三件事同时发生：

1. **Console 报错 `401 ACTOR_NOT_FOUND`**：浏览器 Network 面板看到 `/api/context` 返回 401，body 是 `{"error":{"message":"...","code":"ACTOR_NOT_FOUND","request_id":"..."}}`。
2. **UI 显示「Unauthorized」三个字**：而不是后端的精确诊断（`actor=agent-001 在 tenant=demo-tenant 下不存在`）。
3. **页面挤成窄缝**：登录进去后整个 workspace 页面只有左侧 200px 一条，右侧空白；同一个失败状态在聊天流里出现三次。

这三个症状其实指向三个不同根因，但都在同一次会话里撞上。

---

## 二、根因 1：demo 用户与 seed 用户错位

后端 seed 数据长这样：

```python
# src/customer_service_ai/seed.py
SEED_ACTORS = {
    "tenant-a": {
        "sup-001":   ("张主管",   "supervisor"),
        "agent-001": ("李客服",   "agent"),
        "agent-002": ("王客服",   "agent"),
        "qa-001":    ("赵质检",   "qa"),
        "merch-001": ("刘商品",   "merchandiser"),
    },
}
```

前端 `DEMO_USERS` 用的是历史 demo 账号：

```ts
// src/features/auth/types.ts (原版)
export const DEMO_USERS = [
  { id: "sales-101", name: "销售员 101", tenantId: "demo-tenant", role: "agent" },
  { id: "sup-001",   name: "张主管",      tenantId: "demo-tenant", role: "supervisor" },
];
```

`tenant=demo-tenant` 根本不在 seed 里，所以任何 demo 账号都会 401。

**修复**：前端 `DEMO_USERS` 改成跟后端 seed 完全对齐——`tenantId: "tenant-a"`，`id` 用 `sup-001`/`agent-001`/`agent-002`/`qa-001`/`merch-001`，`name` 用「张主管/李客服/王客服/赵质检/刘商品」。

---

## 三、根因 2：错误信封没解开 + auth bootstrap 有竞态

前端 `apiClient` 的 `parseError` 只看了两种结构：

```ts
// src/lib/api/client.ts (原版)
if (typeof body === "string") return new Error(body);
if (body.message)  return new ApiError(body.message);
if (body.detail)   return new ApiError(body.detail);    // FastAPI 默认 detail 字段
return new Error("Unknown error");
```

但后端统一返回的是 `{error: {message, code, request_id, recovery, object_ref}}` 信封。所以 401 ACTOR_NOT_FOUND 走到 fallback，被简化成 "Unauthorized"。

竞态问题更阴：`AuthProvider` 在 bootstrap 阶段从 localStorage 读上次登录的用户，**但 singleton apiClient 的 header 是单独异步设置的**。如果用户刷新页面，会出现这样的时序：

```text
t=0: AuthProvider 从 localStorage 读出 user，开始 hydrate
t=1: ProtectedRoute 看到 user 已存在，跳过 LoginPage
t=2: AssistantWorkspace 渲染，组件内 useEffect 发起 /api/context 请求
t=3: apiClient 此刻还没把 X-Tenant-ID/X-Actor-ID 设上
t=4: /api/context 返回 401（无 actor header）→ 跳转登录页
t=5: AuthProvider 完成 hydrate，开始设 header
```

表现就是「我明明登录了，刷新一下就被踢出来」。

**修复**：

```ts
// 1. 错误信封解开
export function parseError(body: any, status: number): ApiError {
  if (body?.error?.message) {
    return new ApiError(body.error.message, status, body.error.code, body.error.request_id);
  }
  if (typeof body?.message === "string") return new ApiError(body.message, status);
  if (typeof body?.detail === "string")  return new ApiError(body.detail, status);
  return new ApiError("Unknown error", status);
}

// 2. AuthProvider 暴露 isBootstrapping
const AuthContext = createContext<{
  user: User | null;
  isBootstrapping: boolean;          // ← 新增
  login: (id: string) => Promise<void>;
  logout: () => void;
}>(...);

// 3. ProtectedRoute 在 isBootstrapping=true 时显示 spinner，不要 redirect
function ProtectedRoute({ children }) {
  const { user, isBootstrapping } = useAuth();
  if (isBootstrapping) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" />;
  return <>{children}</>;
}

// 4. 用户 hydrate 后立即同步 header
useEffect(() => {
  if (user) apiClient.setHeaders({
    "X-Tenant-ID": user.tenantId,
    "X-Actor-ID":  user.id,
    "X-API-Key":   user.apiKey,
  });
}, [user]);

// 5. login 后调 /api/context 验一次，401 就清掉 credentials
async function login(userId: string) {
  const candidate = DEMO_USERS.find(u => u.id === userId);
  apiClient.setHeaders({...candidate});
  const ctx = await apiClient.get("/api/context");
  if (ctx.status === 401) {
    apiClient.clearHeaders();
    throw new Error("后端拒绝该 demo 账号，请检查租户/演员是否 seed");
  }
  setUser(candidate);
  localStorage.setItem("user", JSON.stringify(candidate));
}
```

---

## 四、根因 3：CSS 双重身份把页面挤成窄缝

`styles.css` 和 `globals.css` 同时定义了 `.assistant-workspace`：

```css
/* globals.css (旧版) */
.assistant-workspace { display: flex; flex-direction: column; height: 100dvh; }

/* styles.css (新版) */
.assistant-workspace { display: grid; grid-template-rows: auto 1fr; padding: 24px; max-width: 720px; }
```

两个 CSS 都生效，flex + grid 同时跑，结果父容器被 grid 的 max-width 限制到 720px，左边 padding 24px，右边 padding 24px，中间可用宽度不到 300px。

**修复**：

```css
/* globals.css: 删掉旧的 .assistant-workspace（line 145-187） */

/* styles.css: 重命名为 .assistant-chat，专门给 chat root 用 */
.assistant-chat {
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
}

/* src/App.tsx: 外层用 .workspace-page */
<div className="workspace-page">
  <AssistantDrawer />
  <AssistantWorkspace />   {/* 这里用 .assistant-chat */}
</div>
```

---

## 五、可复用清单 · 多租户前端启动前

跑前端之前过一遍：

| 检查 | 命令 / 做法 |
|---|---|
| 后端 seed 的 tenant | `grep -A 30 SEED_ACTORS src/.../seed.py` |
| 前端 DEMO_USERS 的 tenantId | `grep -A 10 DEMO_USERS src/.../types.ts` |
| 两者完全对齐？ | `tenant` 字段、`id` 字段、`name` 字段一一对应 |
| 错误信封 | 后端统一返回 `{error:{...}}` 时，前端 `parseError` 要解信封 |
| bootstrap 竞态 | `ProtectedRoute` 必须等 `isBootstrapping=false` |
| CSS 同名 class | `grep -rn "class.*\.assistant-workspace" src/` |

---

## 六、相关坑

- [[2026-08-08-pitfalls-04-css-grid-orphan-cells]] · 同一个项目里删 JSX 留下空 grid cell；与这里的「两个 CSS 共存」都是「删东西没删干净」家族的。
- [[2026-08-08-pitfalls-01-python-sqlite3-context-rollback]] · 后端 auth 服务也会踩 sqlite3 回滚坑；前端拿到的 401 有可能是后端事务回滚后没真正落库导致的。
- [[2026-08-08-pitfalls-10-email-verification-full-pipeline]] · 真要做完整注册流，必然要带邮箱验证码；前端那个 60s 倒计时按钮就是第 10 篇里服务端的镜像。