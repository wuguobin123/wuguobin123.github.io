"use client";

import { useEffect } from "react";

const SECTION_IDS = ["top", "about", "work", "notes", "contact"];

export default function ScrollMotion() {
  useEffect(() => {
    const root = document.documentElement;
    const header = document.querySelector<HTMLElement>(".site-header");
    const revealItems = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    const sectionItems = SECTION_IDS.map((id) => document.getElementById(id)).filter(
      (section): section is HTMLElement => section !== null,
    );
    const navItems = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("[data-nav]"),
    );
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    const updateScrollState = () => {
      frame = 0;

      const maxScroll = Math.max(
        document.documentElement.scrollHeight - window.innerHeight,
        1,
      );
      const progress = Math.min(Math.max(window.scrollY / maxScroll, 0), 1);
      root.style.setProperty("--scroll-progress", progress.toFixed(4));
      header?.classList.toggle("is-scrolled", window.scrollY > 18);

      const marker = window.scrollY + (header?.offsetHeight ?? 0) + 120;
      let activeId = sectionItems[0]?.id ?? "";

      for (const section of sectionItems) {
        if (section.offsetTop <= marker) {
          activeId = section.id;
        }
      }

      for (const item of navItems) {
        const isActive = item.hash === `#${activeId}`;
        item.classList.toggle("is-active", isActive);

        if (isActive) {
          item.setAttribute("aria-current", "location");
        } else {
          item.removeAttribute("aria-current");
        }
      }
    };

    const queueScrollUpdate = () => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(updateScrollState);
      }
    };

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

    updateScrollState();
    window.addEventListener("scroll", queueScrollUpdate, { passive: true });
    window.addEventListener("resize", queueScrollUpdate);

    return () => {
      window.removeEventListener("scroll", queueScrollUpdate);
      window.removeEventListener("resize", queueScrollUpdate);
      revealObserver?.disconnect();
      root.classList.remove("motion-ready");
      root.style.removeProperty("--scroll-progress");

      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  return null;
}
