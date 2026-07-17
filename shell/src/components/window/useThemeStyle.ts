"use client";

import { useEffect, useState } from "react";

/**
 * Mirrors the `data-theme-style` attribute on document.documentElement, which
 * the theme system mutates outside React (see `applyTheme` in hooks/useTheme).
 * The mount read + MutationObserver is the canonical external-store
 * subscription for a DOM attribute that is not derivable in render.
 */
export function useThemeStyle() {
  const [style, setStyle] = useState<string>("flat");
  useEffect(() => {
    const root = document.documentElement;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-initialize-state -- syncs from an external DOM source: the `data-theme-style` attribute is mutated outside React (by the theme system) and is not derivable in render; the mount read + MutationObserver mirror is the canonical external-store subscription
    setStyle(root.getAttribute("data-theme-style") ?? "flat");
    const observer = new MutationObserver(() => {
      setStyle(root.getAttribute("data-theme-style") ?? "flat");
    });
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- observer subscription that keeps `style` mirrored to the external DOM attribute; the value originates outside React, not from a render-time initializer
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme-style"] });
    return () => observer.disconnect();
  }, []);
  return style;
}
