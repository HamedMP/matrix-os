/**
 * Which panes fit beside the page. The outline (240px), a readable page
 * (480px) and the side panel (360px) need 1080px together; in a narrower
 * window the side panel takes the outline's place while it is open. The
 * matching layout rules are in `../styles.css`.
 */

import { useCallback, useSyncExternalStore } from "react";

/** The outline and the side panel do not both fit beside the page. */
export const NARROW_QUERY = "(max-width: 1080px)";
/** The outline does not fit beside the page: it lies over it, and is closed at first. */
export const COMPACT_QUERY = "(max-width: 720px)";

/** Whether the window matches a media query now. False where media queries are not available. */
export function mediaMatches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Follows a media query as the window is resized. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => mediaMatches(query), () => false);
}

/** The outline shows when it is on, unless a narrow window gives its room to the open side panel. */
export function outlineVisible(outlineOpen: boolean, panelOpen: boolean, narrow: boolean): boolean {
  return outlineOpen && !(narrow && panelOpen);
}
