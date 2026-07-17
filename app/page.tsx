import { formatPostDate, getAllPosts } from "@/lib/posts";
import ScrollMotion from "./ScrollMotion";

export default function Home() {
  const posts = getAllPosts();
  const featuredPost = posts[0];
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  return (
    <main>
      <ScrollMotion />
      <header className="site-header">
        <a className="brand" href="#top" aria-label="回到首页顶部">
          <span className="brand-mark">W</span>
          <span>
            <strong>WUGUOBIN</strong>
            <small>独立开发者 · AI 实践者</small>
          </span>
        </a>
        <nav aria-label="主要导航">
          <a href="#about" data-nav>关于</a>
          <a href="#work" data-nav>实践</a>
          <a href="#notes" data-nav>知见</a>
          <a href="#contact" data-nav>联系</a>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-kicker" data-reveal>
          <span>10+ 年全栈经验</span>
          <span>近 3 年 AI 产品实践</span>
        </div>
        <h1 data-reveal data-reveal-delay="1">
          <span className="hero-line">把复杂技术，</span>
          <span className="hero-line">
            做成真正<strong>可用的 AI 产品。</strong>
          </span>
        </h1>
        <div className="hero-footer" data-reveal data-reveal-delay="2">
          <p>
            我是 wuguobin，持续探索 AI 在客服、外贸、知识生产与软件研发中的落地方式。
            这里记录方法、项目和仍在发生的思考。
          </p>
          <a className="circle-link" href="#notes" aria-label="阅读最新文章">
            阅读
            <br />
            知见 <span aria-hidden="true">↘</span>
          </a>
        </div>
        <div className="hero-grid" aria-hidden="true" data-reveal data-reveal-delay="3">
          <span>AI PRODUCT</span>
          <span>FULL-STACK</span>
          <span>OPEN SOURCE</span>
          <span>KNOWLEDGE</span>
        </div>
      </section>

      <section className="about section" id="about">
        <div className="section-label" data-reveal>
          <span>01</span>
          <p>关于我</p>
        </div>
        <div className="about-copy" data-reveal data-reveal-delay="1">
          <p className="lead">
            从全栈研发到 AI 产品，我更在意技术如何穿过演示，进入真实业务流程。
          </p>
          <div className="about-columns">
            <p>
              过去十多年，我在产品、研发和交付之间工作。近三年重点探索客服场景中的
              AI 外呼、AI 质检，以及 AI 在外贸和组品中的应用。
            </p>
            <p>
              我相信好的 AI 产品不是多一个对话框，而是重新组织信息、工具、人员与决策边界。
              这个博客也是我的公开工作台：写下验证过的方法，也保留正在形成的问题。
            </p>
          </div>
        </div>
      </section>

      <section className="work section" id="work">
        <div className="section-label" data-reveal>
          <span>02</span>
          <p>实践方向</p>
        </div>
        <div className="work-list">
          <article data-reveal>
            <span className="work-number">01</span>
            <div>
              <p className="eyebrow">AI × CUSTOMER SERVICE</p>
              <h2>客服 AI 产品</h2>
              <p>外呼、质检与人机协作流程，把模型能力嵌入可度量、可追踪的业务闭环。</p>
            </div>
            <span className="work-arrow" aria-hidden="true">↗</span>
          </article>
          <article data-reveal data-reveal-delay="1">
            <span className="work-number">02</span>
            <div>
              <p className="eyebrow">AGENTS × ENGINEERING</p>
              <h2>多智能体系统</h2>
              <p>研究 Agent 的角色边界、工作流编排、记忆系统、验证门禁与工程化落地。</p>
            </div>
            <span className="work-arrow" aria-hidden="true">↗</span>
          </article>
          <article data-reveal data-reveal-delay="2">
            <span className="work-number">03</span>
            <div>
              <p className="eyebrow">OBSIDIAN × OPEN SOURCE</p>
              <h2>知识生产系统</h2>
              <p>用 Markdown、自动化与 AI，把零散收藏变成可检索、可复用、可发布的知识资产。</p>
            </div>
            <span className="work-arrow" aria-hidden="true">↗</span>
          </article>
        </div>
      </section>

      <section className="notes section" id="notes">
        <div className="notes-head" data-reveal>
          <div className="section-label">
            <span>03</span>
            <p>日新知见</p>
          </div>
          <p className="notes-intro">从 Markdown 原稿直接发布。观点会更新，过程有迹可循。</p>
        </div>

        {featuredPost ? (
          <a
            className="featured-note"
            href={`${basePath}/posts/${featuredPost.slug}/`}
            data-reveal
            data-reveal-delay="1"
          >
            <div>
              <p className="eyebrow">LATEST NOTE · {formatPostDate(featuredPost.date)}</p>
              <h2>{featuredPost.title}</h2>
              <p>{featuredPost.description}</p>
            </div>
            <span aria-hidden="true">读全文 ↗</span>
          </a>
        ) : null}

        <div className="note-list" data-reveal data-reveal-delay="2">
          {posts.slice(1).map((post, index) => (
            <a href={`${basePath}/posts/${post.slug}/`} key={post.slug}>
              <span className="note-index">{String(index + 2).padStart(2, "0")}</span>
              <div>
                <h3>{post.title}</h3>
                <p>{post.description}</p>
              </div>
              <div className="note-meta">
                <span>{formatPostDate(post.date)}</span>
                <span>{post.readingTime} 分钟</span>
              </div>
            </a>
          ))}
        </div>
      </section>

      <section className="contact section" id="contact">
        <p className="eyebrow" data-reveal>LET&apos;S BUILD SOMETHING USEFUL</p>
        <h2 data-reveal data-reveal-delay="1">一起探索下一件<br />值得做的事。</h2>
        <div className="contact-row" data-reveal data-reveal-delay="2">
          <p>如果你也在做 AI 产品、Agent 工程或知识系统，欢迎交换实践。</p>
          <a href="https://github.com/wuguobin123" target="_blank" rel="noreferrer">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>

      <footer>
        <span>© {new Date().getFullYear()} WUGUOBIN</span>
        <span>OBSIDIAN → MARKDOWN → GITHUB PAGES</span>
        <a href="#top">回到顶部 ↑</a>
      </footer>
    </main>
  );
}
