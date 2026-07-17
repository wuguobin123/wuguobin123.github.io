import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatPostDate, getAllPosts, getPostBySlug } from "@/lib/posts";

type PostPageProps = {
  params: Promise<{ slug: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: PostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  if (!post) return {};

  return {
    title: post.title,
    description: post.description,
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      publishedTime: post.date,
      tags: post.tags,
    },
  };
}

export default async function PostPage({ params }: PostPageProps) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  if (!post) notFound();

  return (
    <main className="article-shell">
      <header className="article-header-bar">
        <a className="brand" href={`${basePath}/`}>
          <span className="brand-mark">W</span>
          <span>
            <strong>WUGUOBIN</strong>
            <small>日新知见</small>
          </span>
        </a>
        <a className="back-link" href={`${basePath}/#notes`}>← 返回文章列表</a>
      </header>

      <article className="article-page">
        <header className="article-hero">
          <p className="eyebrow">NOTE · {formatPostDate(post.date)}</p>
          <h1>{post.title}</h1>
          <p className="article-description">{post.description}</p>
          <div className="article-meta">
            <span>{post.readingTime} 分钟阅读</span>
            {post.tags.map((tag) => <span key={tag}>#{tag}</span>)}
          </div>
        </header>

        <div className="article-layout">
          <aside>
            <span>WUGUOBIN / NOTE</span>
            <p>用 Obsidian 写作，以 Markdown 保存，通过 GitHub 自动发布。</p>
          </aside>
          <div
            className="prose"
            dangerouslySetInnerHTML={{ __html: post.html }}
          />
        </div>
      </article>

      <section className="article-end">
        <p>持续写，持续验证。</p>
        <a href={`${basePath}/#notes`}>阅读更多知见 <span aria-hidden="true">↗</span></a>
      </section>
    </main>
  );
}
