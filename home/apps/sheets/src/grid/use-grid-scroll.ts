import { type RefObject, useLayoutEffect, useMemo } from "react";
import type { GridContext, GridLayout } from "./context";
import { HEADER_HEIGHT_PX, ROW_HEADER_WIDTH_PX } from "./geometry";
import { createScrollScale, maxScroll } from "./viewport";

export interface GridScroll {
  /** Extra scroll range of the native scrollbars beyond the visible surface, in pixels. */
  nativeWidth: number;
  nativeHeight: number;
  /** Call from the scroll container's `onScroll`. */
  onScroll(): void;
}

/**
 * Ties the native scrollbars of the scroll container to the view of the
 * active sheet, both ways, and measures the room there is for cells.
 *
 * The scrollbars are the owner's handle on the view (wheel, drag, touch pad);
 * keyboard moves and sheet switches set the view and the scrollbars follow.
 * For sheets taller than a browser can scroll, the scrollbar position is
 * scaled (see `createScrollScale`).
 */
export function useGridScroll(ctx: GridContext, scroller: RefObject<HTMLDivElement | null>, layout: GridLayout): GridScroll {
  const limit = maxScroll(layout.viewportInput);
  const scaleX = useMemo(() => createScrollScale(limit.left), [limit.left]);
  const scaleY = useMemo(() => createScrollScale(limit.top), [limit.top]);
  const { scrollTop, scrollLeft } = layout.viewport;
  const sheet = layout.sheet;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = (): void => {
      const width = element.clientWidth - ROW_HEADER_WIDTH_PX;
      const height = element.clientHeight - HEADER_HEIGHT_PX;
      // Without layout (a test environment) the defaults stay.
      if (width > 0 && height > 0) ctx.store.set({ width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ctx, scroller]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const top = scaleY.toNative(scrollTop);
    const left = scaleX.toNative(scrollLeft);
    if (Math.abs(element.scrollTop - top) >= 1) element.scrollTop = top;
    if (Math.abs(element.scrollLeft - left) >= 1) element.scrollLeft = left;
  }, [scroller, scrollTop, scrollLeft, scaleX, scaleY, sheet]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (element === null) return;
    const current = ctx.layout().viewport;
    const movedTop = Math.abs(element.scrollTop - scaleY.toNative(current.scrollTop)) >= 1;
    const movedLeft = Math.abs(element.scrollLeft - scaleX.toNative(current.scrollLeft)) >= 1;
    if (!movedTop && !movedLeft) return;
    ctx.store.setView(ctx.sheet, {
      scrollTop: movedTop ? scaleY.toSheet(element.scrollTop) : current.scrollTop,
      scrollLeft: movedLeft ? scaleX.toSheet(element.scrollLeft) : current.scrollLeft,
    });
  };

  return { nativeWidth: scaleX.nativeMax, nativeHeight: scaleY.nativeMax, onScroll };
}
