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

const PAGE_SIZE = 6;

export default function PostsDirectory({ posts, basePath }: PostsDirectoryProps) {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("全部");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
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
  const visiblePosts = filteredPosts.slice(0, visibleCount);
  const hasMore = visiblePosts.length < filteredPosts.length;

  const clearFilters = () => {
    setQuery("");
    setActiveTag("全部");
    setVisibleCount(PAGE_SIZE);
  };

  return (
    <>
      <section className="directory-controls" aria-label="筛选文章">
        <label className="directory-search">
          <span className="directory-search-label">搜索文章</span>
          <input
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
            placeholder="搜索文章..."
            type="search"
            value={query}
          />
          <span className="directory-search-icon" aria-hidden="true">⌕</span>
        </label>
        <div className="directory-tags" aria-label="按标签筛选">
          {["全部", ...tags].map((tag) => (
            <button
              aria-pressed={activeTag === tag}
              key={tag}
              onClick={() => {
                setActiveTag(tag);
                setVisibleCount(PAGE_SIZE);
              }}
              type="button"
            >
              {tag}{tag === "全部" ? ` · ${posts.length}` : ""}
            </button>
          ))}
        </div>
      </section>

      <div className="directory-result-head" aria-live="polite">
        <span>
          显示 {String(visiblePosts.length).padStart(2, "0")} / {String(filteredPosts.length).padStart(2, "0")}
        </span>
        <span>{activeTag === "全部" ? "全部主题" : `#${activeTag}`}</span>
      </div>

      {filteredPosts.length > 0 ? (
        <>
          <div className="directory-list">
            {visiblePosts.map((post) => (
              <a href={`${basePath}/posts/${post.slug}/`} key={post.slug}>
                <div className="directory-card-meta">
                  <span>{post.dateLabel}</span>
                  <span>{post.readingTime} MIN READ</span>
                </div>
                <div className="directory-card-main">
                  <h2>{post.title}</h2>
                  <p>{post.description}</p>
                  <div className="directory-card-tags">
                    {post.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}
                  </div>
                </div>
                <span className="directory-card-arrow" aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
          {hasMore ? (
            <div className="directory-load-more">
              <button
                onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                type="button"
              >
                加载更多文章 <span aria-hidden="true">＋</span>
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="directory-empty">
          <p>没有找到匹配的文章。</p>
          <button onClick={clearFilters} type="button">清除筛选</button>
        </div>
      )}
    </>
  );
}
