"use client";

import { useMemo, useState } from "react";

export type DirectoryPost = {
  slug: string;
  title: string;
  dateLabel: string;
  description: string;
  tags: string[];
  readingTime: number;
};

type PostsDirectoryProps = {
  posts: DirectoryPost[];
  basePath: string;
};

export default function PostsDirectory({ posts, basePath }: PostsDirectoryProps) {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("全部");
  const tags = useMemo(
    () => Array.from(new Set(posts.flatMap((post) => post.tags))).sort(),
    [posts],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredPosts = posts.filter((post) => {
    const matchesTag = activeTag === "全部" || post.tags.includes(activeTag);
    const searchable = [post.title, post.description, ...post.tags]
      .join(" ")
      .toLocaleLowerCase("zh-CN");
    return matchesTag && (!normalizedQuery || searchable.includes(normalizedQuery));
  });

  const clearFilters = () => {
    setQuery("");
    setActiveTag("全部");
  };

  return (
    <>
      <section className="directory-controls" aria-label="筛选文章">
        <label className="directory-search">
          <span>搜索文章</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入标题、内容简介或标签"
            type="search"
            value={query}
          />
        </label>
        <div className="directory-tags" aria-label="按标签筛选">
          {["全部", ...tags].map((tag) => (
            <button
              aria-pressed={activeTag === tag}
              key={tag}
              onClick={() => setActiveTag(tag)}
              type="button"
            >
              {tag}{tag === "全部" ? ` · ${posts.length}` : ""}
            </button>
          ))}
        </div>
      </section>

      <div className="directory-result-head" aria-live="polite">
        <span>{String(filteredPosts.length).padStart(2, "0")} 篇结果</span>
        <span>{activeTag === "全部" ? "全部主题" : `#${activeTag}`}</span>
      </div>

      {filteredPosts.length > 0 ? (
        <div className="directory-list">
          {filteredPosts.map((post, index) => (
            <a href={`${basePath}/posts/${post.slug}/`} key={post.slug}>
              <span className="directory-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="directory-card-main">
                <h2>{post.title}</h2>
                <p>{post.description}</p>
                <div className="directory-card-tags">
                  {post.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                </div>
              </div>
              <div className="directory-card-meta">
                <span>{post.dateLabel}</span>
                <span>{post.readingTime} 分钟</span>
                <b aria-hidden="true">↗</b>
              </div>
            </a>
          ))}
        </div>
      ) : (
        <div className="directory-empty">
          <p>没有找到匹配的文章。</p>
          <button onClick={clearFilters} type="button">清除筛选</button>
        </div>
      )}
    </>
  );
}
