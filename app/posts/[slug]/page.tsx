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
        <div className="article-back-row">
          <a href={`${basePath}/posts/`}>
            <span aria-hidden="true">←</span> BACK TO ARTICLES
          </a>
        </div>

        <header className="article-hero">
          <div className="article-labels">
            <span>NOTE · {formatPostDate(post.date)}</span>
            {post.tags.slice(0, 4).map((tag, index) => (
              <span className={index % 2 === 0 ? "is-lime" : "is-dark"} key={tag}>
                #{tag}
              </span>
            ))}
          </div>
          <h1>{post.title}</h1>
          <p className="article-description">{post.description}</p>
          <div className="article-info-band">
            <div className="article-author">
              <span className="article-author-mark" aria-hidden="true">W</span>
              <div>
                <small>AUTHOR</small>
                <strong>WUGUOBIN</strong>
              </div>
            </div>
            <div className="article-stats">
              <div>
                <small>READING TIME</small>
                <strong>{post.readingTime} MINUTES</strong>
              </div>
              <div>
                <small>VISIBILITY</small>
                <strong>PUBLIC NOTE</strong>
              </div>
            </div>
          </div>
        </header>

        <section className="article-cover" aria-hidden="true">
          <div className="article-cover-grid" />
          <span>WUGUOBIN / DIGITAL GARDEN</span>
          <strong>IDEAS<br />IN PUBLIC</strong>
          <i>{String(currentIndex + 1).padStart(2, "0")}</i>
        </section>

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
          <aside className="article-sidebar article-toc-desktop">
            <div className="article-summary">
              <span>SUMMARY</span>
              <p>{post.description}</p>
            </div>
            <span>CONTENTS</span>
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
        </div>

        <section className="article-inline-cta">
          <div>
            <span>KEEP BUILDING IN PUBLIC</span>
            <h2>把想法写下来，把方法变成作品。</h2>
            <p>这里持续记录 AI 产品、Agent 工程与知识生产系统的真实实践。</p>
          </div>
          <a href={`${basePath}/posts/`}>浏览全部文章 ↗</a>
        </section>

        <nav className="article-pager" aria-label="相邻文章">
          {previousPost ? (
            <a href={`${basePath}/posts/${previousPost.slug}/`}>
              <span>PREVIOUS POST</span>
              <strong>{previousPost.title}</strong>
            </a>
          ) : <span />}
          {nextPost ? (
            <a className="is-next" href={`${basePath}/posts/${nextPost.slug}/`}>
              <span>NEXT POST</span>
              <strong>{nextPost.title}</strong>
            </a>
          ) : <span />}
        </nav>
      </article>

      <section className="article-end">
        <p>WUGUOBIN · 日新知见</p>
        <a href={`${basePath}/posts/`}>进入文章目录 <span aria-hidden="true">↗</span></a>
      </section>
    </main>
  );
}
