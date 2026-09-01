---
title: "实战踩坑录 13 · RAG 链路 best-of-breed 组合：解析用 RAGFlow、分块用 RAGFlow、融合用 RAGFlow、插件化用 Dify、压缩用 OpenClaw"
date: "2026-08-08"
description: "ServicePilot agent 平台已具备意图识别 + 能力注册 + DAG 编排，但要补完整知识库 RAG。直接从 RAGFlow（解析/分块/融合）、Dify（embedding/vector store/rerank 插件化）、OpenClaw（上下文压缩）三个开源项目各取所长组合一条 RAG 链路。"
tags: [RAG, RAGFlow, Dify, OpenClaw, Embedding, Rerank, Hybrid]
draft: true
---

## 一、Context

现有 ServicePilot agent 平台：

- 意图识别 + 能力注册 + DAG 编排 → 执行 → 持久化/审计（架构完整）
- 缺完整 RAG 问答链路

需求：高召回准确率 + 支持 pdf/docx/ppt/xlsx/md 多格式。一次设计到位，不要先做个半成品再迭代。

---

## 二、设计原则

每个环节都从开源项目里挑最强的一段，不重造轮子：

| 环节 | 借鉴来源 | 选它的原因 |
|---|---|---|
| **文档解析** | RAGFlow DeepDoc | 自研 ONNX 版面分析 + 表格识别 + OCR，PDF 结构化深度碾压开源 → 直接提升召回 |
| **分块** | RAGFlow 类型化分块 + LLM 增强 | 按文档类型选分块策略；摄入时 LLM 抽关键词/自动提问 → 检索加权 |
| **向量化** | Dify 插件化 | 保持和现有 provider 架构一致，可接任意 embedding provider |
| **向量存储/检索** | Dify 插件化 | 同上，可接任意向量库 |
| **检索融合** | RAGFlow 加权融合 | 词频/向量混合加权，比 RRF 更透明易调，直接提升准确率 |
| **Rerank** | Dify 插件化 | provider 插件化，可选任意 rerank 模型 |
| **引用溯源** | RAGFlow 句级匹配 | 句粒度引用 + 坐标高亮，前端能精准定位来源 |
| **上下文压缩** | OpenClaw | 会话级 token 预算裁剪；micro-compact 保留溯源 |
| **高级检索（可选）** | RAGFlow GraphRAG/RAPTOR | 深度语义问答开箱即用 |

---

## 三、目录结构

```
src/customer_service_ai/
├── rag/
│   ├── __init__.py
│   ├── parser/
│   │   ├── base_parser.py
│   │   ├── pdf_parser.py            # DeepDoc 风格：ONNX 版面 + 表格 + OCR
│   │   ├── docx_parser.py
│   │   ├── ppt_parser.py
│   │   ├── xlsx_parser.py
│   │   ├── markdown_parser.py
│   ├── chunker/
│   │   ├── naive_chunker.py        # token 合并（默认）
│   │   ├── hierarchical_chunker.py  # 标题层级
│   │   ├── qa_chunker.py           # QA 对
│   │   ├── table_chunker.py        # 表格
│   ├── embedding/
│   │   ├── embedding_factory.py    # 工厂 + registry
│   ├── vector_store/
│   │   ├── vector_factory.py       # 工厂 + entry point 注册
│   ├── retrieval/
│   │   ├── hybrid_retriever.py     # BM25 + 向量 加权融合
│   ├── rerank/
│   │   ├── rerank_factory.py       # 工厂 + registry
│   ├── citation/
│   │   ├── citation_builder.py     # 带 ID 坐标
│   │   ├── match_annotator.py      # 句- chunk 匹配
│   ├── compaction/
│   │   ├── budget_compactor.py     # token 预算裁剪 + micro-compact
│   ├── advanced/                   # 可选
│   │   ├── graph_rag.py
│   │   ├── raptor.py
```

---

## 四、关键实现点（为什么准确率高）

### 4.1 深度文档解析（DeepDoc）

普通 PyPDF2 / pdfplumber 拿到的文本会丢掉：

- 表格结构（多列、合并单元格）
- 阅读顺序（PDF 是页面坐标系）
- 图注关系（图片 vs 文字）

DeepDoc 用 ONNX 模型做版面分析，把页面切成「段落 / 表格 / 图片」三类区域，再用专用模型识别表格 / OCR 图片。这样下游分块时：

- 表格整体保留为一个 chunk（不被切碎）
- 阅读顺序按版面分析结果拼接
- OCR 文本与正文按区域绑定

```python
# src/customer_service_ai/rag/parser/pdf_parser.py（简化）
from deepdoc.parser import PdfParser as DeepDocPdf

class PdfParser(BaseParser):
    def __init__(self, *, ocr_enabled=False):
        self._inner = DeepDocPdf(ocr=ocr_enabled)

    def parse(self, path: Path) -> list[ParsedSection]:
        sections = self._inner(path=str(path))        # 内部 ONNX 推理
        return [
            ParsedSection(
                kind=s.type,        # paragraph / table / figure
                text=s.text,
                bbox=s.bbox,        # (x0, y0, x1, y1) 坐标
                page=s.page,
            )
            for s in sections
        ]
```

### 4.2 分块后 LLM 增强（RAGFlow 风格）

Naive 按 token 切块的 chunk 检索命中率有限。RAGFlow 在 chunk 落库前再用 LLM 做两步增强：

1. **抽关键词**：让 LLM 给这个 chunk 生成 3-5 个关键词，存到 chunk metadata。
2. **自动提问**：让 LLM 根据 chunk 内容生成 3-5 个「这个问题应该用这个 chunk 回答」的伪问题，存到 chunk metadata。

检索时同时匹配：原文 + 关键词 + 伪问题 → 召回率显著提升。

```python
async def llm_enhance_chunk(chunk: Chunk, *, llm) -> Chunk:
    keywords = await llm.chat(
        prompt=f"从以下文本中抽取 3-5 个检索关键词，用空格分隔：\n\n{chunk.text}",
        max_tokens=64,
    )
    questions = await llm.chat(
        prompt=f"根据以下文本，生成 3-5 个适合用这段文本回答的问题，每行一个：\n\n{chunk.text}",
        max_tokens=128,
    )
    chunk.metadata["keywords"] = keywords.strip().split()
    chunk.metadata["questions"] = [q.strip() for q in questions.splitlines() if q.strip()]
    return chunk
```

成本：每个 chunk 两次小 LLM 调用（关键词 + 提问），可用 `gpt-4o-mini` / 本地 7B 模型。**生产只对高频类型（FAQ / 产品手册）开**，默认关闭。

### 4.3 hybrid 加权融合（RAGFlow）

RRF（reciprocal rank fusion）简单但难调：权重不直观，调参只能凭感觉。RAGFlow 的加权融合更直接：

```python
def hybrid_score(chunk: Chunk, query: str,
                 *, bm25_weight=0.3, vector_weight=0.6, authority_weight=0.1) -> float:
    bm = bm25_score(query, chunk.text)
    vec = cosine_sim(query_embedding, chunk.embedding)
    auth = chunk.metadata.get("authority", 0.5)
    return bm25_weight * bm + vector_weight * vec + authority_weight * auth
```

权重可在 RAG admin 后台可视化调，命中 / 召回指标实时看。

### 4.4 句级引用

RAGFlow 的引用是「这个答案里的第 N 句对应 chunk 的第 M 句」：

```python
def annotate_citations(answer: str, chunks: list[Chunk]) -> list[Citation]:
    cites = []
    for sent in split_sentences(answer):
        best_chunk, best_sim = None, -1.0
        for c in chunks:
            for c_sent in split_sentences(c.text):
                sim = cosine_sim(embed(sent), embed(c_sent))
                if sim > best_sim:
                    best_sim, best_chunk = sim, c
        if best_chunk and best_sim > 0.7:
            cites.append(Citation(
                text=sent,
                chunk_id=best_chunk.id,
                chunk_sentence=best_chunk.text,
                score=best_sim,
                bbox=best_chunk.bbox,    # 句级坐标，前端可高亮
            ))
    return cites
```

前端 `<Citation id={n} />` 组件能精确定位到原 PDF 的某一行 / 某个表格单元格。

### 4.5 预算压缩（OpenClaw）

agent 长会话里 RAG 检索结果往往塞不进剩余 token 预算。OpenClaw 的 budget_compactor 做两件事：

1. **token 预算裁剪**：按 `(citation 完整 → 摘要 → 删除)` 三级降级，确保剩余 chunk 在预算内。
2. **micro-compact**：被裁的 chunk 保留「最相关的 1-2 句」+ 「完整引用 ID」，需要时再展开。

```python
class BudgetCompactor:
    def __init__(self, *, max_tokens: int = 2000):
        self._max = max_tokens

    def compact(self, chunks: list[Chunk]) -> list[Chunk]:
        out, used = [], 0
        for c in sorted(chunks, key=lambda x: x.score, reverse=True):
            full = tokens(c.text)
            if used + full <= self._max:
                out.append(c); used += full
            else:
                # micro-compact：只留前两句 + 引用 ID
                preview = " ".join(split_sentences(c.text)[:2])
                out.append(c.model_copy(update={"text": preview,
                                                "metadata": {**c.metadata,
                                                             "compact": True}}))
                used += tokens(preview)
        return out
```

---

## 五、插件化（Dify 模式）

embedding / vector store / rerank 全部走 provider 抽象，方便接任意模型：

```python
# embedding factory
class EmbeddingFactory:
    _registry: dict[str, type[EmbeddingProvider]] = {}

    @classmethod
    def register(cls, name: str):
        def deco(klass):
            cls._registry[name] = klass
            return klass
        return deco

    @classmethod
    def create(cls, settings: Settings) -> EmbeddingProvider:
        name = settings.embedding_provider
        if name not in cls._registry:
            raise ValueError(f"未知 embedding provider: {name}")
        return cls._registry[name](settings)

@EmbeddingFactory.register("openai")
class OpenAIEmbedding(EmbeddingProvider):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...

@EmbeddingFactory.register("bge-local")
class BGELocalEmbedding(EmbeddingProvider):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...

@EmbeddingFactory.register("cohere")
class CohereEmbedding(EmbeddingProvider):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...
```

`Settings.embedding_provider = "openai"` → 工厂自动选 OpenAI 实现。`vector_store` / `rerank` 同样模式。

---

## 六、验证

### 6.1 摄入

```bash
$ python -c "
from customer_service_ai.rag.pipeline import RagIngestPipeline
p = RagIngestPipeline.from_settings()
result = p.ingest_file('docs/sample.pdf', knowledge_base='product-manual')
print(result.chunk_count, result.embedding_count)
"
42 42  # 42 个 chunk，42 个 embedding
```

### 6.2 检索

```bash
$ python -c "
from customer_service_ai.rag.retrieval import HybridRetriever
r = HybridRetriever.from_settings()
hits = r.search('退款政策', knowledge_base='product-manual', top_k=5)
for h in hits:
    print(f'[{h.score:.3f}] {h.citation.chunk_id}: {h.snippet[:80]}')
"
[0.842] chunk_007: 用户购买后 7 天内可申请无理由退款...
[0.731] chunk_023: 退款流程如下...
```

### 6.3 端到端

```bash
$ pytest tests/test_rag/ -q
# 覆盖核心流程 + 句级引用 + 预算压缩
```

期望：

- 摄入后 `chunk_count > 0`，每个 chunk 有 `embedding` / `keywords` / `questions` 字段（如开启 LLM 增强）。
- 检索 `top_k` 个 hit 按 `score` 降序。
- 引用 `chunk_id` 与原文档坐标对应。
- 压缩后总 token 数 ≤ 预算上限，`compact=true` 的 chunk 在 UI 有标记。

---

## 七、可复用清单 · RAG 链路设计

| 决策 | 选择 |
|---|---|
| 解析 | 重 PDF / 表格多的文档用 DeepDoc 类版面分析；纯文本 docx/markdown 用朴素解析器。 |
| 分块 | 默认 naive（token 合并）；QA / 表格类文档用专用 chunker。LLM 增强默认关，按知识库类型启用。 |
| Embedding | 插件化工厂；默认 OpenAI / BGE 本地；存到 chunk metadata 时同时存 model 名，便于切换后重建。 |
| Vector store | 插件化；起步用 FAISS / chroma；规模上来换 Qdrant / Milvus。 |
| Hybrid 融合 | 加权融合（BM25 / 向量 / authority）权重可调；RRF 仅在不可解释权重时用。 |
| Rerank | 默认开 cross-encoder；插件化实现可关。 |
| 引用 | 句级坐标 + chunk id；UI 高亮定位到原 PDF / Word。 |
| 压缩 | token 预算裁剪 + micro-compact 保留溯源；按 session 级别管理。 |
| 高级检索 | GraphRAG / RAPTOR 留给「需要全局语义」的查询；普通 FAQ 不要开。 |

---

## 八、相关坑

- [[2026-08-08-pitfalls-05-search-fallback-kills-github]] · 多 provider 选型思路一致：通用走顺序 / 默认，技术 / 垂直走并行 / 专项。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · RAG 各环节都是「输入 → 处理 → 输出」的统一模式，跟 capability 注册同样的三件套（Input / handler / 注册）。
- [[2026-08-08-pitfalls-01-python-sqlite3-context-rollback]] · 摄入流水线的状态表如果用 SQLite，「块内 raise → 回滚」会再次出现，注意第 01 篇的写法。