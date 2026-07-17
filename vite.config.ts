import vinext from "vinext";
import { defineConfig } from "vite";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const isUserOrOrganizationPage = repositoryName.endsWith(".github.io");
const hasCustomDomain = Boolean(process.env.CUSTOM_DOMAIN);
const pagesBasePath =
  process.env.GITHUB_ACTIONS && repositoryName && !isUserOrOrganizationPage && !hasCustomDomain
    ? `/${repositoryName}`
    : "";

export default defineConfig({
  base: pagesBasePath ? `${pagesBasePath}/` : "/",
  plugins: [vinext()],
});
