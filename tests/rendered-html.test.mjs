import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

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
  assert.doesNotMatch(homepage, /codex-preview|react-loading-skeleton/);
  assert.match(directory, /文章目录/);
  assert.match(directory, /搜索文章/);
  assert.match(article, /个人品牌，比简历有效100倍/);
  assert.match(article, /本篇目录/);
});

test("keeps GitHub Pages metadata in the exported artifact", async () => {
  await access(new URL("dist/client/.nojekyll", root));
});
