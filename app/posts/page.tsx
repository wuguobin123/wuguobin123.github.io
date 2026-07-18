import type { Metadata } from "next";
import { formatPostDate, getAllPosts } from "@/lib/posts";
import PostsDirectory from "./PostsDirectory";

export const metadata: Metadata = {
  title: "文章目录",
  description: "浏览 wuguobin 关于 AI 产品、Agent 工程、开源工具和知识生产的全部文章。",
};

export default function PostsPage() {
  const posts = getAllPosts();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  return (
    <>
      <header className="article-header-bar posts-index-header">
        <a className="brand" href={`${basePath}/`}>
          <span className="brand-mark">W</span>
          <span>
            <strong>WUGUOBIN</strong>
            <small>日新知见</small>
          </span>
        </a>
        <nav className="posts-index-nav" aria-label="文章页导航">
          <a href={`${basePath}/`}>首页</a>
          <a className="is-active" href={`${basePath}/posts/`}>文章</a>
          <a href={`${basePath}/#contact`}>联系</a>
        </nav>
      </header>

      <main className="posts-index-page">
        <header className="posts-index-hero">
          <p className="eyebrow">WRITING ARCHIVE · {posts.length} NOTES</p>
          <div>
            <div className="posts-index-hero-copy">
              <h1>文章目录</h1>
              <p>
                这里记录的不是最终答案，而是认知形成的过程：从实践中提出问题，
                在写作中校准判断，再用新的行动继续验证。
              </p>
            </div>
            <span className="posts-index-hero-mark" aria-hidden="true">文</span>
          </div>
        </header>

        <PostsDirectory
          basePath={basePath}
          posts={posts.map((post) => ({
            slug: post.slug,
            title: post.title,
            dateLabel: formatPostDate(post.date),
            description: post.description,
            tags: post.tags,
            readingTime: post.readingTime,
          }))}
        />
      </main>

      <footer>
        <span>© {new Date().getFullYear()} WUGUOBIN</span>
        <span>{posts.length} NOTES · KEEP SHIPPING</span>
        <a href="mailto:wgblearn@163.com">wgblearn@163.com</a>
        <a href={`${basePath}/`}>返回首页 ↑</a>
      </footer>
    </>
  );
}
