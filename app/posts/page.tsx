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
      <header className="article-header-bar">
        <a className="brand" href={`${basePath}/`}>
          <span className="brand-mark">W</span>
          <span>
            <strong>WUGUOBIN</strong>
            <small>日新知见</small>
          </span>
        </a>
        <a className="back-link" href={`${basePath}/`}>← 返回首页</a>
      </header>

      <main className="posts-index-page">
        <header className="posts-index-hero">
          <p className="eyebrow">WRITING ARCHIVE · {posts.length} NOTES</p>
          <div>
            <h1>文章目录</h1>
            <p>
              从最新思考开始，也可以按主题或关键词寻找。每篇文章都来自 Markdown，
              会随着实践继续更新。
            </p>
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
        <a href={`${basePath}/`}>返回首页 ↑</a>
      </footer>
    </>
  );
}
