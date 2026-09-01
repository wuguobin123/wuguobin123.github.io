---
title: "实战踩坑录 05 · 顺序 fallback 把 GitHub 压在队尾：技术查询要并行 fan-out"
date: "2026-08-08"
description: "ChainSearchProvider 把 ddg/bing/baidu/github 串起来，前三个只要任何一个返回结果就停。技术类子问题（库实现/issue 讨论/代码片段）GitHub 永远拿不到证据。修法是给技术查询开并行分支 + 用 markdownify 做服务端兜底抓取。"
tags: [搜索, RAG, GitHub, DeepResearch, Fallback]
draft: true
---

## 一、症状

跑「AI 记忆实现方案」深度调研，技术子问题全部 `evidence_status: insufficient`：

| 子问题 | DDG | Bing | Baidu | GitHub | 结果 |
|---|---|---|---|---|---|
| Mem0 源码结构 | 0 | 0 | 0 | 5 | insufficient |
| LangMem 与 Zep 对比 | 0 | 2 (博客营销页) | 0 | — | web_matched（错的） |
| Letta KV cache 设计 | 0 | 0 | 0 | 3 | insufficient |

期望：GitHub 那 5 条要进入证据池。
实际：GitHub 一次都没被调，因为它在 fallback 链尾。

---

## 二、根因

`ChainSearchProvider` 的实现长这样：

```python
# src/customer_service_ai/workbench/research/service.py (原版)
class ChainSearchProvider:
    def __init__(self, providers: Sequence[SearchProvider]):
        self._providers = providers        # [ddg, bing, baidu, github]

    async def search(self, query: str, *, limit: int = 5) -> list[dict]:
        for p in self._providers:
            try:
                results = await p.search(query, limit=limit)
                if results:               # ← 任何一个 provider 有结果就立刻返回
                    return results
            except SearchBackendUnavailable:
                continue
        return []
```

加上 `GitHubCliSearchProvider` 只硬编码了一种粒度：

```python
class GitHubCliSearchProvider:
    async def search(self, query, *, limit=5):
        cmd = ["gh", "search", "repos", ...]    # 只搜 repos
```

两个问题叠加：

1. **顺序链尾**：DDG / Bing / Baidu 任一返回结果（哪怕只是博客营销页），GitHub 一次都不跑。
2. **粒度单一**：就算 GitHub 跑，也只搜 repos，看不到 issue 讨论、代码片段、commit 详情。

技术类问题（库、框架、SDK、issue、源码）的关键证据恰好就在 GitHub 的 issue / code / discussion 里，所以全部「拿不到」。

---

## 三、修复

三步走：扩展 GitHub 粒度、加并行分支、加 markdownify 兜底抓取。

### Step 1 · GitHub provider 支持 kind

```python
# src/customer_service_ai/workbench/research/_github.py
from typing import Literal

_GITHUB_FIELDS = {
    "repos":  "fullName,description,url,stargazersCount,updatedAt",
    "issues": "title,url,repository,body,state,updatedAt",
    "code":   "name,path,repository,url,textMatches",
}

class GitHubCliSearchProvider:
    def __init__(self, ..., kind: Literal["repos","issues","code"] = "repos"):
        self.kind = kind

    async def search(self, query, *, limit=5, kind: str | None = None):
        effective = kind or self.kind
        cmd = ["gh", "search", effective, ...]
        # ... 用 _GITHUB_FIELDS[effective] 选择字段
```

### Step 2 · ParallelTechnicalSearchProvider

```python
def _is_technical_query(query: str) -> bool:
    keywords = {
        "实现","方案","库","框架","SDK","API","源码","代码",
        "framework","library","implementation","repo","repository",
        "Mem0","LangMem","LangChain","Zep","Letta","TiMem",
        "KV cache","向量","knowledge graph","memory","记忆",
    }
    q = query.lower()
    return any(k.lower() in q for k in keywords)

class ParallelTechnicalSearchProvider:
    def __init__(self, *, sequential_provider, technical_providers):
        self._seq = sequential_provider
        self._tech = technical_providers    # [ddg, bing, github]

    async def search(self, query, *, limit=5):
        if not _is_technical_query(query):
            return await self._seq.search(query, limit=limit)

        results = await asyncio.gather(
            *[p.search(query, limit=max(limit * 2, 6))
              for p in self._tech],
            return_exceptions=True,
        )
        flat = []
        for r in results:
            if isinstance(r, BaseException):
                continue            # 单 provider 异常静默跳过
            flat.extend(r)

        # 按 _canonical_uri 去重，分数高的保留
        by_uri: dict[str, dict] = {}
        for item in flat:
            uri = _canonical_uri(item["uri"])
            prev = by_uri.get(uri)
            if prev is None or item.get("quality_score", 0) > prev.get("quality_score", 0):
                by_uri[uri] = item
        # 按 quality_score 排序
        return sorted(by_uri.values(),
                      key=lambda x: (x.get("quality_score", 0),
                                     x.get("relevance_score", 0),
                                     x.get("authority_score", 0)),
                      reverse=True)
```

### Step 3 · MarkdownOnlyFetchProvider（服务端兜底抓取）

`browser_extract` 是 desktop 客户端能力，深研服务端用不上。但 `requirements.lock` 里早就锁了 `markdownify==1.2.3`，从来没被 import 过——直接用：

```python
# src/customer_service_ai/workbench/research/fetchers.py
import markdownify

class MarkdownOnlyFetchProvider:
    def __init__(self, *, timeout_seconds=8.0, max_chars=6000):
        self._timeout = timeout_seconds
        self._max_chars = max_chars

    async def fetch(self, url, *, query=""):
        async with httpx.AsyncClient(
            timeout=self._timeout,
            trust_env=False,           # 沙箱代理绕开
            headers={"User-Agent": "Mozilla/5.0"},
        ) as client:
            r = await client.get(url, follow_redirects=True)
            if len(r.content) > 2 * 1024 * 1024:
                return None
            ct = r.headers.get("content-type", "").lower()
            if not any(t in ct for t in ("text/html", "application/xhtml", "text/plain")):
                return None

        md = markdownify.html_markdown(r.text, strip=["script", "style", "nav", "footer"])
        if len(md) < 300:             # 与 _ReadablePageParser 同阈值
            return None
        return {
            "title": ..., "uri": url,
            "snippet": _relevant_excerpt(md, query, self._max_chars),
            "detail_fetched": True,
            "extracted_chars": len(md),
        }
```

`gather_node` 在 primary detail 为空 / 内容 < 300 字时，调 `MarkdownOnlyFetchProvider` 二次抓取，**只替换** `extracted_chars >= len(current_snippet)` 的结果，不重复 reserve fetch 配额。

---

## 四、装配

```python
# src/customer_service_ai/app.py
chain = ChainSearchProvider([ddg, bing, baidu, github_provider])
web_provider = (
    ParallelTechnicalSearchProvider(
        sequential_provider=chain,
        technical_providers=[ddg, bing, github_provider],   # 共享实例
    )
    if settings.assistant_web_search_enabled
    else None
)
```

Baidu **不进并行**——避免 4 路 HTML 流量撞 rate limit；仍然在顺序链兜底里出现。非技术子问题完全不变。

---

## 五、可复用清单 · 多 provider 检索

| 决策 | 选择 |
|---|---|
| provider 是顺序还是并行？ | **看查询类型**：通用查询走顺序省 quota；技术/垂直查询走并行拿覆盖率。 |
| GitHub 类目粒度 | 单 provider 支持 repos/issues/code/discussion 四种，子查询类型决定 kind。 |
| 抓取兜底 | 客户端 SPA 拿不到正文时，服务端用 markdownify 再抓一次；阈值 300 字。 |
| 失败处理 | `asyncio.gather(..., return_exceptions=True)`；单 provider 异常静默转 `[]`，不让一个 provider 把整链路拖垮。 |
| 评分兜底 | 新 provider 没有显式分数时，给 authority=0.5 / quality=0.4*0.5 + 0.5*relevance + 0.1*completeness，不被甩到队尾。 |

测试矩阵（`tests/test_search_provider_chain.py`）：

```python
def test_is_technical_query():
    assert _is_technical_query("AI 记忆实现方案") == True
    assert _is_technical_query("今日北京天气") == False

def test_parallel_provider_dedup():
    # 同一 URI 在两个 provider 出现 → 保留 quality_score 高的
    ...

def test_sequential_provider_unchanged():
    # 非技术查询仍走顺序链，第一个返回就停
    ...
```

Eval 种子（`datasets/deep_research_eval.jsonl`）加 3-5 行 `category: "technical"`，跑完脚本看 `evidence_status` 从 `insufficient` 提升到 `deep_research_matched`。

---

## 六、相关坑

- [[2026-08-08-pitfalls-13-rag-pipeline-composition]] · 同样的「多 provider 选型」思路向上延伸到整条 RAG 链路：解析/分块/融合每一环都从多个开源项目里挑最强的一段组合。
- [[2026-08-08-pitfalls-01-python-sqlite3-context-rollback]] · eval 脚本里如果用 sqlite3 存中间结果，「先写后抛」会让覆盖率统计全 0。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · 搜索能力本身也是 AI agent 的一个 capability；新加 provider 时复用统一注册模式。