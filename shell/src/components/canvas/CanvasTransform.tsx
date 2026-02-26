"use client";

import { useRef, useCallback, useEffect, type ReactNode } from "react";
import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX } from "@/hooks/useCanvasTransform";

interface CanvasTransformProps {
  children: ReactNode;
  className?: string;
  onDoubleClick?: (e: React.MouseEvent) => void;
}

export function CanvasTransform({ children, className, onDoubleClick }: CanvasTransformProps) {
  const zoom = useCanvasTransform((s) => s.zoom);
  const panX = useCanvasTransform((s) => s.panX);
  const panY = useCanvasTransform((s) => s.panY);
  const isAnimating = useCanvasTransform((s) => s.isAnimating);
  const zoomAtPoint = useCanvasTransform((s) => s.zoomAtPoint);
  const panBy = useCanvasTransform((s) => s.panBy);

  const containerRef = useRef<HTMLDivElement>(null);
  const zoomOverlayRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const spaceDown = useRef(false);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom on trackpad sends ctrlKey + wheel
        const delta = -e.deltaY * 0.01;
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + delta));
        zoomAtPoint(newZoom, e.clientX, e.clientY);
      } else {
        // Regular two-finger scroll = pan (Figma-style)
        panBy(-e.deltaX / zoom, -e.deltaY / zoom);
      }
    },
    [zoom, zoomAtPoint, panBy],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Middle-click or Space+click to pan
      if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
        e.preventDefault();
        isPanning.current = true;
        lastPointer.current = { x: e.clientX, y: e.clientY };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning.current) return;
      const dx = (e.clientX - lastPointer.current.x) / zoom;
      const dy = (e.clientY - lastPointer.current.y) / zoom;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      panBy(dx, dy);
    },
    [zoom, panBy],
  );

  const onPointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  // Track space (for pan) and ctrl/cmd (for zoom overlay over iframes)
  useEffect(() => {
    const overlay = zoomOverlayRef.current;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        spaceDown.current = true;
      }
      if ((e.ctrlKey || e.metaKey) && overlay) {
        overlay.style.pointerEvents = "all";
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = false;
      }
      if (!e.ctrlKey && !e.metaKey && overlay) {
        overlay.style.pointerEvents = "none";
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        overflow: "hidden",
        position: "relative",
        width: "100%",
        height: "100%",
        cursor: spaceDown.current || isPanning.current ? "grab" : "default",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Transparent overlay: captures wheel events over iframes when ctrl/cmd held */}
      <div
        ref={zoomOverlayRef}
        className="absolute inset-0 z-50"
        style={{ pointerEvents: "none" }}
      />
      <div
        style={{
          transformOrigin: "0 0",
          transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`,
          pointerEvents: isAnimating ? "none" : "auto",
          willChange: "transform",
        }}
        onDoubleClick={onDoubleClick}
      >
        {children}
      </div>
    </div>
  );
}
