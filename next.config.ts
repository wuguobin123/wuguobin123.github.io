import type { NextConfig } from "next";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const isUserOrOrganizationPage = repositoryName.endsWith(".github.io");
const hasCustomDomain = Boolean(process.env.CUSTOM_DOMAIN);
const pagesBasePath =
  process.env.GITHUB_ACTIONS && repositoryName && !isUserOrOrganizationPage && !hasCustomDomain
    ? `/${repositoryName}`
    : "";

process.env.NEXT_PUBLIC_BASE_PATH = pagesBasePath;

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  assetPrefix: pagesBasePath || undefined,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
