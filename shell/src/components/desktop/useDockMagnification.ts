"use client";

import { useEffect, type RefObject } from "react";

/** Peak magnification for the icon directly under the pointer. */
const MAX_SCALE = 1.6;

/**
 * macOS Dock magnification for a single dock icon.
 *
 * While `enabled`, the icon listens for pointer movement over its closest
 * `[data-dock]` ancestor and scales itself along a Gaussian falloff curve of
 * the pointer-to-icon-center distance: the hovered icon grows toward
 * MAX_SCALE and neighbors shrink off smoothly. Writes go straight to the
 * element's `scale` style (no React re-render per pointermove); the dock's
 * CSS transition (`[data-dock] button` in globals.css) smooths the curve.
 *
 * Non-macOS designs pass `enabled: false` and get zero listeners and zero
 * style writes — behavior is completely unchanged.
 */
export function useDockMagnification(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    const dock = el?.closest<HTMLElement>("[data-dock]");
    if (!el || !dock) return;

    const onMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distance = Math.hypot(event.clientX - centerX, event.clientY - centerY);
      // offsetWidth is layout size (unaffected by the live scale), so the
      // falloff width stays stable while the icon grows.
      const sigma = el.offsetWidth || rect.width || 1;
      const influence = Math.exp(-0.5 * (distance / sigma) ** 2);
      const scale = 1 + (MAX_SCALE - 1) * influence;
      el.style.scale = scale.toFixed(3);
    };
    const onLeave = () => {
      el.style.scale = "";
    };

    dock.addEventListener("pointermove", onMove);
    dock.addEventListener("pointerleave", onLeave);
    return () => {
      dock.removeEventListener("pointermove", onMove);
      dock.removeEventListener("pointerleave", onLeave);
      el.style.scale = "";
    };
  }, [enabled, ref]);
}
