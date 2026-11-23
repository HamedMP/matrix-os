/**
 * Measures a scrolling viewport for the virtualised list: its height (kept
 * current with a ResizeObserver) and scroll offset, plus keeping one row in view.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export const FALLBACK_VIEWPORT_HEIGHT = 600;

function subscribeToSize(element: HTMLElement | null, notify: () => void): () => void {
  if (!element || typeof ResizeObserver === "undefined") return () => undefined;
  const observer = new ResizeObserver(notify);
  observer.observe(element);
  return () => observer.disconnect();
}

export interface Viewport {
  /** Pass as the scrolling element's `ref`. */
  ref: (element: HTMLDivElement | null) => void;
  height: number;
  scrollTop: number;
  onScroll: (event: { currentTarget: HTMLElement }) => void;
}

export function useViewport(rowHeight: number, focusedIndex: number): Viewport {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const subscribe = useCallback((notify: () => void) => subscribeToSize(element, notify), [element]);
  const height = useSyncExternalStore(
    subscribe,
    () => (element && element.clientHeight > 0 ? element.clientHeight : FALLBACK_VIEWPORT_HEIGHT),
    () => FALLBACK_VIEWPORT_HEIGHT,
  );

  useEffect(() => {
    if (!element || focusedIndex < 0) return;
    const top = focusedIndex * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight;
  }, [element, focusedIndex, rowHeight]);

  return {
    ref: setElement,
    height,
    scrollTop,
    onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
  };
}
