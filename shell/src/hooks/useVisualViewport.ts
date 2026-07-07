"use client";

import { useEffect, useState } from "react";

/**
 * Live `window.visualViewport` state for keyboard-aware mobile layout (spec 102).
 *
 * On iOS the layout viewport (`innerHeight`) does not shrink when the on-screen
 * keyboard opens — only the *visual* viewport does. Reading `visualViewport`
 * lets keyboard-adjacent UI (terminal key bar, toasts, sheets) pin itself above
 * the keyboard and the terminal re-`fit()` so the prompt stays visible.
 *
 * - `height`   — visual viewport height in px (visible band).
 * - `offsetTop`— how far the visual viewport is scrolled down from the layout
 *                viewport; translate pinned roots by this to re-anchor them.
 * - `keyboardOpen` — heuristic: layout height − visual height exceeds a
 *                threshold (clears URL-bar jitter, catches real keyboards).
 *
 * SSR-safe: returns sensible defaults until mounted.
 */

export interface VisualViewportState {
  height: number;
  offsetTop: number;
  keyboardOpen: boolean;
}

/** Below this (px) the gap is URL-bar/toolbar jitter, not a real keyboard. */
const KEYBOARD_THRESHOLD = 120;

function readSnapshot(): VisualViewportState {
  if (typeof window === "undefined") {
    return { height: 0, offsetTop: 0, keyboardOpen: false };
  }
  const vv = window.visualViewport;
  if (!vv) {
    return { height: window.innerHeight, offsetTop: 0, keyboardOpen: false };
  }
  const height = vv.height;
  const keyboard = Math.max(0, window.innerHeight - height);
  return {
    height: Math.round(height),
    offsetTop: Math.round(vv.offsetTop),
    keyboardOpen: keyboard > KEYBOARD_THRESHOLD,
  };
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() =>
    typeof window === "undefined"
      ? { height: 0, offsetTop: 0, keyboardOpen: false }
      : readSnapshot(),
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const sync = () => {
      setState((prev) => {
        const next = readSnapshot();
        if (
          prev.height === next.height &&
          prev.offsetTop === next.offsetTop &&
          prev.keyboardOpen === next.keyboardOpen
        ) {
          return prev;
        }
        return next;
      });
    };

    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  return state;
}
