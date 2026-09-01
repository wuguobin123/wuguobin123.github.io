---
title: "实战踩坑录 04 · CSS Grid 删了子元素还留空白格：grid-template-columns 不跟着 JSX 一起死"
date: "2026-08-08"
description: "删掉 IconShield 和『前往』按钮的 JSX 之后，grid-template-columns 的三列还在。左右各留一个空 cell，右侧那个有父元素深色背景渲染成深色方块，截图里看就是一个『删不掉的方框』。"
tags: [CSS, Grid, Frontend, Electron, 调试]
draft: true
---

## 一、症状

浏览器面板地址栏做过一轮精简：

- 删掉左侧盾牌 icon（`<IconShield />`）
- 删掉右侧「前往」按钮（`<button type="submit" className="browser-address__go">前往</button>`）

精简完测试，用户截图反馈：「地址栏左右两边还是有两个方框」。

当时控制台无报错、布局一切正常，唯独两个「方框」顽固存在。

---

## 二、根因

CSS 还在用旧的三列 grid：

```css
/* apps/desktop/src/renderer/styles.css:3549 (原版) */
.browser-address {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 24px;   /* 三列 */
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  background: #171c26;                                /* 深色 */
  border: 1px solid var(--border);
  border-radius: 8px;
}
```

三列分别对应：

| 列 | 宽 | 原 JSX | 删除后 |
|---|---|---|---|
| 1 | `auto` | `<IconShield />` | 空 cell |
| 2 | `minmax(0, 1fr)` | `<input>` | 保留 |
| 3 | `24px` | `<button>前往</button>` | 空 cell，有深色背景 |

**根因**：CSS Grid 的列定义在父容器上，跟子元素 JSX 是两条独立的线。删 JSX 不会反向删除 grid 列。结果就是两个空 cell 留在那里——右边那个 24px 因为有 `#171c26` 背景色，所以渲染成「深色方块」。

左侧那个浅色方块，是 `auto` 列在没内容时宽度变成 0 或 1-2px，但因为 `.browser-address svg`（line 3562）会给所有 svg 描边，可能还有像素残留。

---

## 三、修复

两步走：先改 grid，再清死代码。

### 步骤 1：grid-template-columns 改成单列

```css
.browser-address {
  min-width: 0;
  height: 32px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);   /* 原来: auto minmax(0, 1fr) 24px */
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #171c26;
}
```

### 步骤 2：顺手删三个孤儿 CSS 规则

```css
/* 删掉：.browser-address svg 给所有 svg 染色 */
/* 删掉：.browser-address__go { ... } 和 :hover { ... } */
```

删之前先确认真没引用：

```bash
$ grep -rn "browser-address__go" apps/desktop/src/
apps/desktop/src/renderer/styles.css:3577:    background: var(--ok);
# 只有 styles.css 自己引用

$ grep -rn "browser-address svg" apps/desktop/src/
apps/desktop/src/renderer/styles.css:3562:.browser-address svg {
# 同上
```

全仓库只有 styles.css 自身，没有任何 JSX / 测试引用——可以安全删。

---

## 四、可复用清单 · CSS Grid 子元素变动

每次动 grid 子元素，先问三个问题：

1. **`grid-template-columns` / `grid-template-rows` 的列数 / 行数跟当前子元素数量对得上吗？** 多了就空 cell，少了就 `grid-auto-flow` 兜底（通常不是你想要的）。
2. **空 cell 有没有显式的背景色 / 边框 / 描边？** 有的话一定看得到「方框」。
3. **有没有 `.something svg` 这种「按父类给所有子元素染色」的规则？** 这种规则删除子元素后可能给残留元素继续染色。

更稳的实践：

```css
/* 不要让 grid 列数硬编码子元素数量 — 用 auto-fit / auto-fill */
.address {
  display: grid;
  grid-template-columns: minmax(0, 1fr);   /* 始终一列，input 自适应 */
}

/* 或用 flex 替代 grid，flex 子元素离开后布局自动收紧 */
.address {
  display: flex;
  align-items: center;
  gap: 6px;
}
```

---

## 五、相关坑

- [[2026-08-08-pitfalls-03-frontend-auth-tenant-mismatch]] · 同一类「删不干净」：`.assistant-workspace` 在两个 CSS 里共存，删一个忘另一个。
- [[2026-08-08-pitfalls-07-zip-install-skill-monorepo]] · 文件系统的「删不干净」是另一个家族：unregister 一个 skill 必须把目录移到 `.trash` 而不是 `rm -rf`，否则 watcher 会复活。
- [[2026-08-08-pitfalls-06-two-skill-lifecycles-divergence]] · 同一种「残留状态」的另一种形态：旧 lifecycle 里删掉的注册项没真正从 capability registry 移除。