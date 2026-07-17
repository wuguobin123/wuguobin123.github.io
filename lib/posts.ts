import { marked } from "marked";

export type Post = {
  slug: string;
  title: string;
  date: string;
  description: string;
  tags: string[];
  readingTime: number;
  body: string;
  html: string;
};

type Frontmatter = {
  title?: string;
  date?: string;
  description?: string;
  tags?: string[];
  draft?: boolean;
};

const markdownModules = import.meta.glob<string>("../content/posts/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

function parseValue(value: string): string | string[] | boolean {
  const trimmed = value.trim();

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
      .filter(Boolean);
  }

  return trimmed.replace(/^['\"]|['\"]$/g, "");
}

function parseMarkdown(source: string): { data: Frontmatter; body: string } {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { data: {}, body: source };

  const data = match[1].split("\n").reduce<Frontmatter>((result, line) => {
    const separator = line.indexOf(":");
    if (separator === -1) return result;
    const key = line.slice(0, separator).trim() as keyof Frontmatter;
    const value = parseValue(line.slice(separator + 1));
    return { ...result, [key]: value };
  }, {});

  return { data, body: source.slice(match[0].length).trim() };
}

function estimateReadingTime(markdown: string): number {
  const plainText = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`\-[\]()]|https?:\/\/\S+/g, " ");
  const hanCharacters = plainText.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinWords = plainText.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return Math.max(1, Math.ceil((hanCharacters + latinWords) / 320));
}

function slugFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? "";
}

export function getAllPosts(): Post[] {
  return Object.entries(markdownModules)
    .map(([path, source]) => {
      const slug = slugFromPath(path);
      const { data, body } = parseMarkdown(source);

      if (!slug || slug.startsWith("_") || data.draft) return null;

      const title = data.title ?? slug;
      const date = data.date ?? "1970-01-01";
      const description = data.description ?? body.slice(0, 90);
      const preparedBody = body.replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_match, title: string, alias?: string) => alias ?? title,
      );

      return {
        slug,
        title,
        date,
        description,
        tags: Array.isArray(data.tags) ? data.tags : [],
        readingTime: estimateReadingTime(body),
        body,
        html: marked.parse(preparedBody) as string,
      };
    })
    .filter((post): post is Post => post !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getPostBySlug(slug: string): Post | undefined {
  return getAllPosts().find((post) => post.slug === slug);
}

export function formatPostDate(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(`${date}T00:00:00+08:00`))
    .replaceAll("/", ".");
}
