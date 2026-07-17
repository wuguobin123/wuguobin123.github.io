# wuguobin · 日新知见

一个用 Obsidian 写作、Markdown 保存、GitHub Pages 免费托管的个人博客。

## 本地预览

```bash
npm install
npm run dev
```

访问 `http://localhost:3000`。

## 用 Obsidian 写文章

1. 在 Obsidian 中选择“打开本地仓库”，打开本项目文件夹。
2. 进入 `content/posts`。
3. 复制 `_template.md`，修改文件名、标题、日期、摘要和标签。
4. 把 `draft: true` 改成 `draft: false` 或删除这一行。
5. 提交并推送到 GitHub，GitHub Actions 会自动发布。

建议文件名使用 `YYYY-MM-DD-english-slug.md`，便于得到稳定、可读的文章链接。

## 免费发布到 GitHub Pages

仓库已包含 `.github/workflows/deploy-pages.yml`。

1. 在 GitHub 创建 Public repository，并把本项目推送到 `main`。
2. 打开仓库的 **Settings → Pages**。
3. 在 **Build and deployment** 中选择 **GitHub Actions**。
4. 等待 `Deploy blog to GitHub Pages` 工作流完成。
5. 免费地址通常为 `https://你的用户名.github.io/仓库名/`。

如果仓库名是 `你的用户名.github.io`，免费地址会直接位于域名根目录。

## 后续接入 Cloudflare 自定义域名

先在 GitHub **Settings → Pages → Custom domain** 填写域名，再配置 Cloudflare DNS。不要只在 DNS 中指向 GitHub、却没有先在 GitHub 仓库绑定域名。

如果使用根域名 `example.com`，添加四条 `A` 记录（名称均为 `@`）：

```text
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

如果同时使用 `www.example.com`，添加一条 `CNAME`：

```text
名称：www
目标：wuguobin123.github.io
```

目标中不要包含仓库名。GitHub 建议同时配置根域名与 `www`，以便自动重定向并获得更稳定的 HTTPS。

接入自定义域名后，在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 添加：

- `CUSTOM_DOMAIN`：填写 `true`；
- `SITE_URL`：填写完整地址，例如 `https://example.com/`。

再运行一次 Pages 工作流，站内链接就会从“仓库子路径”切换为“域名根路径”。

> DNS 最长可能需要 24 小时传播。证书尚未签发时，建议先将 Cloudflare 记录设为 DNS only，并在 GitHub Pages 中启用 **Enforce HTTPS**。不要创建通配符 DNS 记录。

## 构建与检查

```bash
npm run build
npm test
```

静态文件输出到 `dist/client`，可以托管在任何静态网站服务上。

## 官方参考

- [GitHub Pages：使用自定义 GitHub Actions 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Pages：管理自定义域名](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Cloudflare Registrar](https://developers.cloudflare.com/registrar/)

## License

MIT
