import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function renderFromWorker(pathname = "/") {
  const workerUrl = new URL("dist/server/index.js", root);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  assert.equal(typeof worker?.fetch, "function");

  return worker.fetch(
    new Request(new URL(pathname, "http://localhost"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("exposes a Cloudflare Worker request handler", async () => {
  const response = await renderFromWorker("/");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(html, /WUGUOBIN/);
  assert.match(html, /日新知见/);
});

test("exports the homepage, directory, and article pages", async () => {
  const homepage = await readFile(new URL("dist/client/index.html", root), "utf8");
  const directory = await readFile(new URL("dist/client/posts/index.html", root), "utf8");
  const article = await readFile(
    new URL("dist/client/posts/2026-07-17-build-a-personal-brand/index.html", root),
    "utf8",
  );

  assert.match(homepage, /把复杂技术/);
  assert.match(homepage, /日新知见/);
  assert.match(homepage, /OBSIDIAN/);
  assert.match(homepage, /mailto:wgblearn@163\.com/);
  assert.match(homepage, /audio\/placid-ambient\.mp3/);
  assert.match(homepage, /Placid Ambient/);
  assert.match(homepage, /MusicLFiles · CC BY 4\.0/);
  assert.doesNotMatch(homepage, /codex-preview|react-loading-skeleton/);
  assert.match(directory, /文章目录/);
  assert.match(directory, /搜索文章/);
  assert.match(directory, /mailto:wgblearn@163\.com/);
  assert.match(article, /个人品牌，比简历有效100倍/);
  assert.match(article, /本篇目录/);
  assert.match(article, /PUBLIC NOTE/);
  assert.match(article, /IDEAS/);
  assert.match(article, /mailto:wgblearn@163\.com/);
});

test("keeps GitHub Pages metadata in the exported artifact", async () => {
  await access(new URL("dist/client/.nojekyll", root));
  await access(new URL("dist/client/audio/placid-ambient.mp3", root));
  await access(new URL("dist/client/audio/ATTRIBUTION.md", root));
});

test("keeps the reusable article publishing skill in the repository", async () => {
  await access(
    new URL(
      "../.agents/skills/blog-article-publisher/SKILL.md",
      import.meta.url,
    ),
  );
});

test("uses one responsive typography scale across article pages", async () => {
  const css = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(css, /--article-title-size:\s*clamp\(/);
  assert.match(css, /--article-body-size:\s*clamp\(/);
  assert.match(css, /font-size:\s*var\(--article-title-size\)/);
  assert.match(css, /font-size:\s*var\(--article-body-size\)/);
  assert.match(css, /\.prose h4\s*\{/);
});

test("renders Markdown tables as readable responsive regions", async () => {
  const article = await readFile(
    new URL(
      "dist/client/posts/2026-07-20-product-design-by-subtraction/index.html",
      root,
    ),
    "utf8",
  );
  const css = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(article, /class="prose-table-scroll"/);
  assert.match(article, /aria-label="可横向滚动的数据表格"/);
  assert.match(article, /<table>/);
  assert.match(css, /\.prose-table-scroll\s*\{/);
  assert.match(css, /min-width:\s*680px/);
  assert.match(css, /overflow-x:\s*auto/);
});
