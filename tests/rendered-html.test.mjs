import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("exports the homepage and article pages", async () => {
  const homepage = await readFile(new URL("dist/client/index.html", root), "utf8");
  const article = await readFile(
    new URL("dist/client/posts/2026-07-17-build-a-blog-in-30-minutes/index.html", root),
    "utf8",
  );

  assert.match(homepage, /把复杂技术/);
  assert.match(homepage, /日新知见/);
  assert.match(homepage, /OBSIDIAN/);
  assert.doesNotMatch(homepage, /codex-preview|react-loading-skeleton/);
  assert.match(article, /30 分钟搭一个个人博客/);
  assert.match(article, /GitHub Pages/);
});

test("keeps GitHub Pages metadata in the exported artifact", async () => {
  await access(new URL("dist/client/.nojekyll", root));
});
