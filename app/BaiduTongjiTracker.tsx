"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    _hmt?: Array<[string, ...unknown[]]>;
  }
}

/**
 * 百度统计的 hm.js 只自动上报首次加载的页面；
 * Next 前端路由切换不会刷新页面，需要手动补发 _trackPageview。
 */
export default function BaiduTongjiTracker() {
  const pathname = usePathname();
  const firstRender = useRef(true);

  useEffect(() => {
    // 跳过首次渲染，避免与 hm.js 自动上报重复计数
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window._hmt?.push(["_trackPageview", pathname]);
  }, [pathname]);

  return null;
}
