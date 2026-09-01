---
title: "实战踩坑录 11 · AI 能力补齐的统一注册模式：7 个新能力一晚上接完"
date: "2026-08-08"
description: "工作台内置 capability 偏弱，参考 OpenClaw / Claude Code 一次性补 7 个能力（image_gen / tts / task / canvas / image_understand / browser_automation / file_write）。全程复用 Pydantic Input → async handler → CapabilityResult → registry.register_skill() 这一套模式。"
tags: [AI Agent, Capability, 注册模式, EdgeTTS, Playwright, 多模态]
draft: true
---

## 一、症状

Enterprise AI Workbench 的内置能力比 OpenClaw / Claude Code 明显偏弱：

| 能力 | OpenClaw 有 | Workbench 有 |
|---|---|---|
| 图片生成 | ✅ image-generate | ❌ |
| 语音合成 | ✅ tts (edge-tts) | ❌ |
| 任务/待办 | ✅ goal-tools + update-plan | ❌ |
| 交互式 HTML | ✅ dashboard | ❌ |
| 图片理解 | ✅ image-tool | ❌ |
| 浏览器自动化 | ✅ browser (Playwright) | ❌ |
| 文件写入 | ✅ write | ⚠️ 只有 export，无 inline 写 |

希望一次性补齐这 7 个，每个都按已有模式走。

---

## 二、统一注册模式

所有能力都长这样：

```python
# 1. Pydantic Input Model
class ImageGenerateInput(BaseModel):
    prompt: str
    size: str = "1024x1024"
    style: str = "vivid"
    count: int = Field(default=1, ge=1, le=4)

# 2. async handler
async def handle_image_generate(req: ImageGenerateInput, ctx: CapabilityContext) -> CapabilityResult:
    if not settings.image_generation_enabled:
        return CapabilityResult(status="unavailable", output={"reason": "未配置 API key"})
    try:
        data = await image_service.generate(req.prompt, req.size, req.style, req.count)
        artifact = await artifact_service.save_generated_file(
            data, filename=f"image-{uuid4().hex[:8]}.png", mime_type="image/png",
        )
    except ImageGenerationError as e:
        return CapabilityResult(status="error", output={"error": str(e)})
    return CapabilityResult(
        status="ok",
        output={"artifacts": [artifact.to_ref()]},
    )

# 3. 注册
registry.register_skill(
    capability_id="workbench.image_generate",
    handler=handle_image_generate,
    input_model=ImageGenerateInput,
    risk_level=CapabilityRisk.EXTERNAL_SIDE_EFFECT,    # 有外部费用
)
```

只要这三步一致，能力注册就和插拔电池一样：新增、改 risk、改 input model 都局部化，不会扩散到 runtime / agent loop。

---

## 三、7 个能力的实现要点

### 1 · workbench.image_generate

参考 OpenClaw `image-generate-tool.ts`，接 OpenAI 兼容 images API。

```python
# src/customer_service_ai/workbench/image_service.py
class ImageGenerationService:
    def __init__(self, *, base_url, api_key, model, timeout_seconds):
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._model = model
        self._timeout = timeout_seconds

    async def generate(self, prompt, size, style, count):
        async with httpx.AsyncClient(timeout=self._timeout) as c:
            r = await c.post(
                f"{self._base}/images/generations",
                headers={"Authorization": f"Bearer {self._key}"},
                json={"model": self._model, "prompt": prompt,
                      "size": size, "style": style, "n": count},
            )
            r.raise_for_status()
            data = r.json()
        return base64.b64decode(data["data"][0]["b64_json"])
```

`risk_level = EXTERNAL_SIDE_EFFECT`（每次调用都要钱）。

### 2 · workbench.tts

`edge-tts` 免费、不需要 API key。

```python
# src/customer_service_ai/workbench/tts_service.py
import edge_tts

class TtsService:
    def __init__(self, *, default_voice="zh-CN-XiaoxiaoNeural", default_rate="+0%"):
        self._voice, self._rate = default_voice, default_rate

    async def synthesize(self, text: str, voice: str | None = None,
                         rate: str | None = None) -> bytes:
        comm = edge_tts.Communicate(
            text,
            voice=voice or self._voice,
            rate=rate or self._rate,
        )
        buf = io.BytesIO()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        if buf.tell() == 0:
            raise TtsError("edge-tts 没返回音频数据")
        return buf.getvalue()
```

`risk_level = READ_ONLY`（纯计算，无副作用）。前端 `DocumentPreviewPanel` 加 `previewKind === 'audio'` 分支：`<audio controls src={blobUrl}>`。

### 3 · workbench.task_manage

参考 OpenClaw `goal-tools.ts`。

```python
# src/customer_service_ai/workbench/task_store.py
class TaskStore:
    def initialize(self):
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','cancelled')),
                priority TEXT NOT NULL DEFAULT 'normal',
                due_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_tenant_actor
                ON tasks(tenant_id, actor_id);
        """)

    def create_task(self, *, tenant_id, actor_id, title, description="",
                    priority="normal", due_at=None) -> dict: ...
    def list_tasks(self, *, tenant_id, actor_id, status=None) -> list[dict]: ...
    def update_task(self, *, tenant_id, actor_id, task_id, **fields) -> dict: ...
    def delete_task(self, *, tenant_id, actor_id, task_id) -> None: ...
```

Input 用 `Literal["create","list","update","delete","get"]` 做 action 分发。`risk_level = DRAFT_WRITE`。

### 4 · workbench.canvas

简化为生成独立 HTML artifact（不搞 tab/widget 那套复杂的状态）。

```python
class CanvasInput(BaseModel):
    title: str
    content_markdown: str
    chart_data: dict | None = None
    chart_type: Literal["bar","line","pie"] | None = None

async def handle_canvas(req, ctx):
    html = await artifact_service.generate_html_document(
        title=req.title,
        markdown=req.content_markdown,
        chart_data=req.chart_data,
        chart_type=req.chart_type,
    )
    artifact = await artifact_service.save_generated_file(
        html.encode(), filename=f"{req.title}.html", mime_type="text/html",
    )
    return CapabilityResult(status="ok", output={"artifacts": [artifact.to_ref()]})
```

图表用纯 JS（无外部 CDN，离线可用）：简单 bar/line/pie 用 SVG 或 Canvas API 渲染。前端已有 `BrowserPanel` (iframe) 直接展示。

### 5 · workbench.image_understand

```python
async def handle_image_understand(req: ImageUnderstandInput, ctx):
    bytes_ = await artifacts.resolve_content(req.artifact_id)
    b64 = base64.b64encode(bytes_).decode()
    async with httpx.AsyncClient(timeout=settings.image_understand_timeout_seconds) as c:
        r = await c.post(
            f"{settings.image_understand_base_url or settings.model_base_url}/chat/completions",
            headers={"Authorization": f"Bearer {settings.image_understand_api_key or settings.model_api_key}"},
            json={
                "model": settings.image_understand_model,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": req.question or "描述这张图片"},
                        {"type": "image_url",
                         "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ],
                }],
            },
        )
    answer = r.json()["choices"][0]["message"]["content"]
    return CapabilityResult(status="ok", output={"answer": answer})
```

`binding hook` 约束 `artifact_id` 只能是本轮附件（同 `file_analyze` 模式）。

### 6 · workbench.browser_automation

服务端 Playwright 方案。

```python
# src/customer_service_ai/workbench/browser_service.py
class BrowserAutomationService:
    def __init__(self, *, headless=True, timeout_seconds=30.0):
        self._headless = headless
        self._timeout = timeout_seconds
        self._pw = None
        self._browser = None

    async def _ensure_browser(self):
        if self._browser is not None:
            return
        from playwright.async_api import async_playwright
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(headless=self._headless)

    async def navigate(self, url: str) -> None:
        await self._ensure_browser()
        page = await self._browser.new_page()
        try:
            if not is_public_url(url):
                raise BrowserAutomationError("禁止访问内网 URL")
            await page.goto(url, timeout=self._timeout * 1000)
        finally:
            await page.close()

    async def screenshot(self, url: str) -> bytes:
        await self._ensure_browser()
        page = await self._browser.new_page()
        try:
            await page.goto(url, timeout=self._timeout * 1000)
            return await page.screenshot(full_page=True)
        finally:
            await page.close()
```

部署时需执行 `playwright install chromium`。每次调用新建 page、用完关闭（避免状态泄漏）。SSRF 守卫复用现有 `is_public_url`。

### 7 · workbench.file_write

```python
class FileWriteInput(BaseModel):
    filename: str = Field(..., pattern=r"^[A-Za-z0-9._\-/]+$")     # 禁路径穿越
    content: str
    file_type: Literal["txt","md","html","json","csv","yaml"] = "txt"

async def handle_file_write(req, ctx):
    # 禁止 ../ 或绝对路径
    if ".." in req.filename or req.filename.startswith("/"):
        return CapabilityResult(status="error", output={"error": "非法路径"})
    artifact = await artifact_service.save_generated_file(
        req.content.encode(), filename=req.filename, mime_type=f"text/{req.file_type}",
    )
    return CapabilityResult(status="ok", output={"artifacts": [artifact.to_ref()]})
```

`risk_level = DRAFT_WRITE`。

---

## 四、注册顺序与 `_BUILTIN_IDS`

在 `_register_builtin_capabilities()` 末尾追加 7 个注册调用，并把 7 个 capability_id 加入 `_BUILTIN_IDS` 集合：

```python
# src/customer_service_ai/workbench/assistant/runtime.py
_BUILTIN_IDS = {
    "workbench.file_analyze",
    "workbench.file_read",
    # ... 原有
    "workbench.image_generate",       # 新增
    "workbench.tts",
    "workbench.task_manage",
    "workbench.canvas",
    "workbench.image_understand",
    "workbench.browser_automation",
    "workbench.file_write",
}

def _register_builtin_capabilities(self):
    # ... 原有注册
    self.registry.register_skill(
        capability_id="workbench.image_generate",
        handler=self.handle_image_generate,
        input_model=ImageGenerateInput,
        risk_level=CapabilityRisk.EXTERNAL_SIDE_EFFECT,
    )
    # ... 其余 6 个同样模式
```

系统提示词 `_system_prompt` 同步追加工具说明：

```python
_TOOL_DESCRIPTIONS = """
...
- workbench.image_generate: 生成图片（需配置 API key）
- workbench.tts: 文字转语音（edge-tts，默认 zh-CN-XiaoxiaoNeural）
- workbench.task_manage: 管理任务/待办（create/list/update/delete/get）
- workbench.canvas: 生成交互式 HTML artifact
- workbench.image_understand: 用 vision 模型分析图片
- workbench.browser_automation: 服务端 Playwright 自动化（需开启）
- workbench.file_write: 写文件到 artifact workspace
"""
```

---

## 五、配置开关

每个能力都加 `*_enabled: bool = False`（默认关闭，显式开），避免新能力误开导致费用 / 副作用：

```python
class Settings(BaseSettings):
    image_generation_enabled: bool = False
    image_generation_base_url: str = "https://api.openai.com/v1"
    image_generation_api_key: str = ""
    image_generation_model: str = "dall-e-3"
    image_generation_timeout_seconds: float = Field(default=60.0, ge=5.0, le=300.0)

    tts_enabled: bool = True
    tts_voice: str = "zh-CN-XiaoxiaoNeural"
    tts_rate: str = "+0%"

    task_manage_enabled: bool = True
    task_database_path: Path = Path("data/workbench_tasks.sqlite3")

    canvas_enabled: bool = True

    image_understand_enabled: bool = False
    image_understand_base_url: str = ""
    image_understand_api_key: str = ""
    image_understand_model: str = "gpt-4o"

    browser_automation_enabled: bool = False
    browser_automation_timeout_seconds: float = Field(default=30.0, ge=5.0, le=120.0)
    browser_automation_headless: bool = True

    file_write_enabled: bool = True
```

`pyproject.toml` 加两个依赖：`edge-tts>=6.1.0` 和 `playwright>=1.40.0`。部署文档里加一句 `playwright install chromium`。

---

## 六、可复用清单 · 加新能力

1. **永远是「Input Model + handler + register_skill」三件套**。不要直接改 `runtime.py` 的主循环。
2. **`risk_level` 必须显式标**：READ_ONLY / DRAFT_WRITE / EXTERNAL_SIDE_EFFECT / 等。agent loop 根据这个决定要不要确认弹窗。
3. **`*_enabled` 默认 `False`**：未配 API key / 未装依赖的能力默认关闭，避免新部署上来就调外部服务。
4. **`_BUILTIN_IDS` 集合与 register 调用一一对应**：加一个忘另一个会出现「agent 看到能力但 handler 没注册」的幽灵能力。
5. **能力描述进系统提示词**：`_system_prompt` 的 `<available_capabilities>` 段落必须同步追加；否则 agent 不知道有这个能力。
6. **artifact 走统一 `ArtifactService.save_generated_file`**：不要让 handler 自己写文件，路径 / 大小 / 类型校验全集中在 service。

---

## 七、相关坑

- [[2026-08-08-pitfalls-06-two-skill-lifecycles-divergence]] · capability 注册和 skill lifecycle 是两套体系：capability 在 registry 里，prompt skill 在另一张表。两者 `id` 命名要避免冲突（建议 capability 用 `workbench.*`，prompt skill 用 slug）。
- [[2026-08-08-pitfalls-08-builtin-skills-vs-docker-volume]] · 内置的 prompt skill（如 frontend-slides）跟内置 capability（这 7 个）是两类：前者是「提示词模板」，后者是「服务端工具」。内置 skill 走 `builtin_skills/` 目录 + Dockerfile COPY；内置 capability 直接在 runtime.py 里 register。
- [[2026-08-08-pitfalls-05-search-fallback-kills-github]] · 搜索能力也是 capability 的一种，新加 provider 时复用本篇的注册模式而不是另起一套。