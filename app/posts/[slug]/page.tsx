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

  const posts = getAllPosts();
  const currentIndex = posts.findIndex((item) => item.slug === post.slug);
  const previousPost = posts[currentIndex + 1];
  const nextPost = posts[currentIndex - 1];
  const relatedPosts = posts
    .filter((item) => item.slug !== post.slug)
    .sort((a, b) => {
      const scoreA = a.tags.filter((tag) => post.tags.includes(tag)).length;
      const scoreB = b.tags.filter((tag) => post.tags.includes(tag)).length;
      return scoreB - scoreA || b.date.localeCompare(a.date);
    })
    .slice(0, 3);

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
        <a className="back-link" href={`${basePath}/posts/`}>← 文章目录</a>
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

        {post.toc.length > 0 ? (
          <details className="article-toc-mobile">
            <summary>本篇目录 · {post.toc.length} 个章节</summary>
            <nav aria-label="本篇文章目录">
              {post.toc.map((item) => (
                <a
                  className={item.level === 3 ? "toc-level-3" : undefined}
                  href={`#${item.id}`}
                  key={item.id}
                >
                  {item.title}
                </a>
              ))}
            </nav>
          </details>
        ) : null}

        <div className="article-layout">
          <aside className="article-toc article-toc-desktop">
            <span>本篇目录</span>
            {post.toc.length > 0 ? (
              <nav aria-label="本篇文章目录">
                {post.toc.map((item) => (
                  <a
                    className={item.level === 3 ? "toc-level-3" : undefined}
                    href={`#${item.id}`}
                    key={item.id}
                  >
                    {item.title}
                  </a>
                ))}
              </nav>
            ) : (
              <p>这是一篇短文章，可直接向下阅读。</p>
            )}
            <a className="toc-all-link" href={`${basePath}/posts/`}>
              查看全部文章 ↗
            </a>
          </aside>
          <div
            className="prose"
            dangerouslySetInnerHTML={{ __html: post.html }}
          />
          <aside className="article-related">
            <span>继续阅读</span>
            {relatedPosts.length > 0 ? (
              <div className="related-list">
                {relatedPosts.map((item) => (
                  <a href={`${basePath}/posts/${item.slug}/`} key={item.slug}>
                    <small>{formatPostDate(item.date)} · {item.readingTime} 分钟</small>
                    <strong>{item.title}</strong>
                  </a>
                ))}
              </div>
            ) : (
              <p>更多文章正在整理中。</p>
            )}
          </aside>
        </div>

        <nav className="article-pager" aria-label="相邻文章">
          {previousPost ? (
            <a href={`${basePath}/posts/${previousPost.slug}/`}>
              <span>← 上一篇</span>
              <strong>{previousPost.title}</strong>
            </a>
          ) : <span />}
          {nextPost ? (
            <a className="is-next" href={`${basePath}/posts/${nextPost.slug}/`}>
              <span>下一篇 →</span>
              <strong>{nextPost.title}</strong>
            </a>
          ) : <span />}
        </nav>
      </article>

      <section className="article-end">
        <p>持续写，持续验证。</p>
        <a href={`${basePath}/posts/`}>进入文章目录 <span aria-hidden="true">↗</span></a>
      </section>
    </main>
  );
}
