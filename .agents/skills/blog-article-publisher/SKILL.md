---
name: blog-article-publisher
description: Use whenever creating, rewriting, reviewing, submitting, or publishing a Markdown article for this blog. Optimizes positioning, structure, readability, metadata, and compatibility with the editorial article-detail layout before validation and publication.
---

# Blog Article Publisher

Turn a Markdown draft into a clear, credible article that fits this blog's
editorial reading system. Use this workflow for every change under
`content/posts/`.

## 1. Confirm the article job

Identify:

- the reader and the problem the article helps them solve;
- the single idea the reader should remember;
- the evidence, experience, project, or source supporting the article;
- whether the task is draft-only, commit-ready, or publish-ready.

Do not invent evidence, results, quotes, people, sources, or product claims.
Preserve uncertainty where the source is uncertain.

## 2. Create valid frontmatter

Use this shape:

```markdown
---
title: "清晰、具体、可以独立传播的标题"
date: "YYYY-MM-DD"
description: "用一到两句话说明读者能获得什么，以及文章的核心判断。"
tags: [主题一, 主题二, 主题三]
---
```

Rules:

- filename: `YYYY-MM-DD-short-english-slug.md`;
- title: normally 12–36 Chinese characters, concrete rather than sensational;
- description: normally 45–100 Chinese characters and usable as a search/social summary;
- tags: 2–6 stable topic labels; reuse existing labels when they fit;
- use `draft: true` only when the article must not be published.

## 3. Optimize the article structure

The body must not contain a level-one heading. The page template renders the
frontmatter title as the only H1.

Recommended sequence:

1. Start with a 2–4 paragraph lead: problem, tension, and core judgment.
2. Use 4–8 `##` sections for the main argument.
3. Use `###` only when a section genuinely needs internal steps or comparison.
4. Put the strongest framework, checklist, example, or evidence in the middle.
5. End with a conclusion that gives the reader a next action or durable idea.

Prefer short paragraphs. A paragraph should usually make one point and stay
within 60–180 Chinese characters. Break up dense paragraphs above roughly 220
characters.

Use:

- numbered lists for ordered steps;
- bullets for parallel ideas;
- blockquotes for one important principle or short attributed excerpt;
- bold text only for phrases the reader should scan;
- code fences only for executable or literal technical material.

Avoid decorative emoji, repeated slogans, fake precision, and long walls of
bold text.

## 4. Write for the article-detail layout

The site owns typography; articles should remain semantic Markdown and must not
embed inline CSS or presentation HTML.

The current reading scale is:

- article title: responsive 36–56 px on desktop and 30–38 px on mobile;
- description: 15.5–19 px, 1.7 line height;
- lead paragraph: 16.5–18 px, 1.85 line height;
- body: 15.5–16.5 px on desktop and 16 px on mobile, 1.9 line height;
- H2: 24–30 px with about 2.75 rem of top spacing;
- H3: 19–22 px;
- H4: 17–19 px;
- blockquote: 16.5–18 px with a lime left rule;
- main text measure: about 720 px.

Write headings that remain useful in the generated table of contents. Prefer
specific headings such as `如何建立第一批可验证作品` over vague headings such
as `更多思考`.

## 5. Run the preflight validator

For one article:

```bash
node .agents/skills/blog-article-publisher/scripts/validate-post.mjs content/posts/<file>.md
```

For the full article collection:

```bash
npm run check:posts
```

Fix every error. Review warnings deliberately; they are editorial guidance, not
automatic rewrite instructions.

Then run the site's existing build/test workflow. Confirm the article route,
generated table of contents, article directory entry, previous/next navigation,
and mobile-safe heading hierarchy.

## 6. Prepare publication safely

- inspect the final diff;
- stage only the intended article, intentional assets, and required site code;
- never stage `.obsidian/` or unrelated deletions by default;
- use a concise commit message such as `Publish article: <short title>`;
- publish only through the repository's current configured hosting workflow;
- report the article URL and any remaining warnings after deployment succeeds.

## Acceptance checklist

- Frontmatter is complete and factually accurate.
- The title and description communicate one clear promise.
- The body has no H1 and has a coherent H2/H3 hierarchy.
- The opening establishes the problem and the conclusion establishes the next step.
- Examples and claims are supported by the provided source or experience.
- Paragraphs are readable at the site's 15.5–16.5 px body scale.
- The generated table of contents is useful rather than repetitive.
- Validation and site build pass.
- The commit excludes unrelated local changes.
