"use client";

import { useEffect, useState } from "react";

function readThemeStyle(): string {
  if (typeof document === "undefined") return "flat";
  return document.documentElement.getAttribute("data-theme-style") ?? "flat";
}

/**
 * Mirrors the `data-theme-style` attribute on document.documentElement, which
 * the theme system mutates outside React (see `applyTheme` in hooks/useTheme).
 * A synchronous client read avoids rendering stale chrome, while the
 * MutationObserver keeps subsequent changes in sync.
 */
export function useThemeStyle() {
  const [style, setStyle] = useState(readThemeStyle);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setStyle(readThemeStyle());
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme-style"] });
    return () => observer.disconnect();
  }, []);
  return style;
}
