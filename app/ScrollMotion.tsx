"use client";

import { useEffect } from "react";

export default function ScrollMotion() {
  useEffect(() => {
    const root = document.documentElement;
    const revealItems = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let revealObserver: IntersectionObserver | undefined;

    if (reduceMotion.matches || !("IntersectionObserver" in window)) {
      revealItems.forEach((item) => item.classList.add("is-visible"));
    } else {
      root.classList.add("motion-ready");
      revealObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              revealObserver?.unobserve(entry.target);
            }
          }
        },
        {
          rootMargin: "0px 0px -10% 0px",
          threshold: 0.12,
        },
      );
      revealItems.forEach((item) => revealObserver?.observe(item));
    }

    return () => {
      revealObserver?.disconnect();
      root.classList.remove("motion-ready");
    };
  }, []);

  return null;
}
