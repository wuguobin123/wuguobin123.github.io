#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const postsDirectory = resolve(root, "content/posts");
const argument = process.argv[2];

if (!argument) {
  console.error(
    "Usage: node .agents/skills/blog-article-publisher/scripts/validate-post.mjs <post.md|--all>",
  );
  process.exit(2);
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function parseTags(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((tag) => unquote(tag))
    .filter(Boolean);
}

function parsePost(source) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { frontmatter: null, body: source };

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return {
    frontmatter,
    body: source.slice(match[0].length).trim(),
  };
}

function textLength(value = "") {
  return [...unquote(value)].length;
}

function validatePost(file, source) {
  const errors = [];
  const warnings = [];
  const { frontmatter, body } = parsePost(source);

  if (!frontmatter) {
    errors.push("missing YAML frontmatter");
    return { errors, warnings };
  }

  for (const field of ["title", "date", "description", "tags"]) {
    if (!frontmatter[field]) errors.push(`missing frontmatter field: ${field}`);
  }

  if (frontmatter.date && !/^["']?\d{4}-\d{2}-\d{2}["']?$/.test(frontmatter.date)) {
    errors.push("date must use YYYY-MM-DD");
  }

  const tags = parseTags(frontmatter.tags ?? "");
  if (frontmatter.tags && tags.length === 0) {
    errors.push("tags must use inline array syntax: [tag one, tag two]");
  } else if (tags.length < 2 || tags.length > 6) {
    warnings.push(`use 2–6 tags; found ${tags.length}`);
  }

  const titleLength = textLength(frontmatter.title);
  if (titleLength < 12 || titleLength > 36) {
    warnings.push(`title is ${titleLength} characters; recommended range is 12–36`);
  }

  const descriptionLength = textLength(frontmatter.description);
  if (descriptionLength < 45 || descriptionLength > 100) {
    warnings.push(
      `description is ${descriptionLength} characters; recommended range is 45–100`,
    );
  }

  if (/^#\s+/m.test(body)) {
    errors.push("body must not contain H1; frontmatter title is rendered as H1");
  }

  const headings = [...body.matchAll(/^(#{2,6})\s+(.+)$/gm)];
  const h2Count = headings.filter(([heading]) => heading.startsWith("## ")).length;
  if (h2Count === 0) errors.push("body must contain at least one H2 section");
  if (h2Count < 4 || h2Count > 8) {
    warnings.push(`found ${h2Count} H2 sections; 4–8 is a useful default`);
  }

  let seenH2 = false;
  for (const [, marks, title] of headings) {
    if (marks.length === 2) seenH2 = true;
    if (marks.length === 3 && !seenH2) {
      errors.push(`H3 appears before the first H2: ${title.trim()}`);
      break;
    }
    if (marks.length > 3) {
      warnings.push(`avoid heading levels deeper than H3: ${title.trim()}`);
    }
  }

  if (/<(style|script)\b|style\s*=/i.test(body)) {
    errors.push("presentation HTML or inline CSS is not allowed in article Markdown");
  }

  const lead = body.split(/\n\s*\n/)[0]?.trim() ?? "";
  if (/^#{2,6}\s/.test(lead)) {
    warnings.push("add a short lead before the first section heading");
  }

  const longParagraphs = body
    .split(/\n\s*\n/)
    .filter((paragraph) => !/^(#|[-*+] |\d+\. |```|>)/.test(paragraph.trim()))
    .filter((paragraph) => [...paragraph.replace(/\s+/g, "")].length > 220);
  if (longParagraphs.length > 0) {
    warnings.push(`${longParagraphs.length} paragraph(s) exceed roughly 220 characters`);
  }

  if (!file.match(/^\d{4}-\d{2}-\d{2}-.+\.md$/)) {
    warnings.push("filename should use YYYY-MM-DD-short-english-slug.md");
  }

  return { errors, warnings };
}

const files = argument === "--all"
  ? (await readdir(postsDirectory))
      .filter((file) => file.endsWith(".md") && !file.startsWith("_"))
      .sort()
  : [argument.replace(/^content\/posts\//, "")];

let errorCount = 0;
let warningCount = 0;

for (const file of files) {
  const source = await readFile(resolve(postsDirectory, file), "utf8");
  const result = validatePost(file, source);
  errorCount += result.errors.length;
  warningCount += result.warnings.length;

  console.log(`\n${file}`);
  for (const error of result.errors) console.log(`  ERROR: ${error}`);
  for (const warning of result.warnings) console.log(`  WARN: ${warning}`);
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("  OK");
  }
}

console.log(`\nChecked ${files.length} post(s): ${errorCount} error(s), ${warningCount} warning(s).`);
if (errorCount > 0) process.exitCode = 1;
