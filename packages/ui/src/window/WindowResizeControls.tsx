"use client";

import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

export type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export interface WindowBounds { x: number; y: number; width: number; height: number }

export function resizeWindowBounds(
  initial: WindowBounds,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  minimum: { width: number; height: number },
): WindowBounds {
  const west = direction.includes("w");
  const north = direction.includes("n");
  const width = west || direction.includes("e")
    ? Math.max(minimum.width, initial.width + (west ? -dx : dx)) : initial.width;
  const height = north || direction.includes("s")
    ? Math.max(minimum.height, initial.height + (north ? -dy : dy)) : initial.height;
  return {
    x: west ? initial.x + initial.width - width : initial.x,
    y: north ? initial.y + initial.height - height : initial.y,
    width,
    height,
  };
}

const directions: ResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const labels: Record<ResizeDirection, string> = {
  n: "top", s: "bottom", e: "right", w: "left",
  ne: "top right", nw: "top left", se: "bottom right", sw: "bottom left",
};

/** An overlay slot on the window frame, above app chrome and outside inert content. */
export function WindowResizeControls({
  bounds, minimum, scale = 1, placement = "inside", onBoundsChange, onInteractionChange, onFocus, className,
}: {
  bounds: WindowBounds;
  minimum: { width: number; height: number };
  scale?: number;
  /** Native content paints above DOM overlays, so its resize targets must sit outside. */
  placement?: "inside" | "outside";
  onBoundsChange: (bounds: WindowBounds) => void;
  onInteractionChange?: (active: boolean) => void;
  onFocus?: () => void;
  className?: string;
}) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const start = (event: ReactPointerEvent<HTMLDivElement>, direction: ResizeDirection) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const initial = bounds;
    const startX = event.clientX;
    const startY = event.clientY;
    const divisor = Math.max(0.01, scale);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      onBoundsChange(resizeWindowBounds(initial, direction,
        (next.clientX - startX) / divisor, (next.clientY - startY) / divisor, minimum));
    };
    const finishPointer = (next: PointerEvent) => {
      if (next.pointerId === pointerId) finish();
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", finishPointer);
      window.removeEventListener("blur", finish);
      target.removeEventListener("lostpointercapture", finishPointer);
      cleanupRef.current = null;
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      onInteractionChange?.(false);
    };
    cleanupRef.current = finish;
    target.setPointerCapture?.(pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    window.addEventListener("blur", finish);
    target.addEventListener("lostpointercapture", finishPointer);
    onFocus?.();
    onInteractionChange?.(true);
  };

  // Keep hit targets usable at canvas zoom levels without covering window controls.
  const outside = placement === "outside";
  const targetScale = Math.max(0.5, scale);
  const edge = (outside ? 12 : 6) / targetScale;
  const corner = (outside ? 24 : 16) / targetScale;
  return <div data-window-resize-controls className={className} style={{ position: "absolute", inset: 0, zIndex: 50, pointerEvents: "none" }}>
    {directions.map((direction) => {
      const diagonal = direction.length === 2;
      const vertical = direction === "n" || direction === "s";
      const style: CSSProperties & { WebkitAppRegion: "no-drag" } = {
        position: "absolute", pointerEvents: "auto", touchAction: "none",
        userSelect: "none", cursor: `${direction}-resize`,
        ...(diagonal ? {
          width: corner, height: corner,
          ...(direction.includes("n") ? { top: outside ? -corner : 0 } : { bottom: outside ? -corner : 0 }),
          ...(direction.includes("w") ? { left: outside ? -corner : 0 } : { right: outside ? -corner : 0 }),
        } : vertical ? {
          left: outside ? 0 : corner, right: outside ? 0 : corner, height: edge,
          ...(direction === "n" ? { top: outside ? -edge : 0 } : { bottom: outside ? -edge : 0 }),
        } : {
          top: outside ? 0 : corner, bottom: outside ? 0 : corner, width: edge,
          ...(direction === "w" ? { left: outside ? -edge : 0 } : { right: outside ? -edge : 0 }),
        }),
        WebkitAppRegion: "no-drag",
      };
      return <div key={direction} data-window-resize={direction} title={`Resize ${labels[direction]}`}
        role="separator" aria-label={`Resize ${labels[direction]}`}
        aria-orientation={diagonal ? undefined : vertical ? "horizontal" : "vertical"}
        className={`no-drag cursor-${direction}-resize`} style={style}
        onPointerDown={(event) => start(event, direction)}>
        {outside && direction === "se" ? (
          <span data-window-resize-grip aria-hidden="true" style={{
            position: "absolute", left: 4 / targetScale, top: 4 / targetScale,
            width: 16 / targetScale, height: 16 / targetScale,
            pointerEvents: "none", color: "var(--text-secondary)",
            background: "color-mix(in srgb, var(--bg-app) 85%, transparent)",
            borderRadius: 4 / targetScale,
          }}>
            <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" focusable="false">
              <path d="M6 18L18 6M12 18L18 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
        ) : null}
      </div>;
    })}
  </div>;
}
