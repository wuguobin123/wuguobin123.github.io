"use client";

import { useEffect } from "react";

function clearHash() {
  if (!window.location.hash) {
    return;
  }

  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

export default function AnchorNavigation() {
  useEffect(() => {
    const initialFrame = window.requestAnimationFrame(clearHash);

    const handleAnchorClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }

      const link = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
      const targetId = link?.hash.slice(1);
      const target = targetId ? document.getElementById(targetId) : null;

      if (!link || !target) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      clearHash();

      const top = target.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top, left: 0, behavior: "auto" });
    };

    document.addEventListener("click", handleAnchorClick, true);

    return () => {
      window.cancelAnimationFrame(initialFrame);
      document.removeEventListener("click", handleAnchorClick, true);
    };
  }, []);

  return null;
}
