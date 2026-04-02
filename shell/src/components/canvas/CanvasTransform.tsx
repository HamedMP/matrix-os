"use client";

import { useRef, useCallback, useEffect, useState, type ReactNode } from "react";
import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX } from "@/hooks/useCanvasTransform";
import { useCanvasSettings } from "@/stores/canvas-settings";

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
  const navMode = useCanvasSettings((s) => s.navMode);

  const containerRef = useRef<HTMLDivElement>(null);
  const zoomOverlayRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const spaceDown = useRef(false);
  const [grabCursor, setGrabCursor] = useState(false);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom on trackpad sends ctrlKey + wheel
        const delta = -e.deltaY * 0.01;
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + delta));
        zoomAtPoint(newZoom, e.clientX, e.clientY);
      } else if (navMode === "scroll") {
        // Scroll mode: two-finger scroll = pan (Figma-style)
        panBy(-e.deltaX / zoom, -e.deltaY / zoom);
      }
      // Grab mode: scroll does nothing (pinch still works via ctrlKey path above)
    },
    [zoom, zoomAtPoint, panBy, navMode],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Middle-click or Space+click to pan (always)
      const isMiddleOrSpace = e.button === 1 || (e.button === 0 && spaceDown.current);
      // Grab mode: left-click on canvas background (container, overlay, or inner transform div -- not app windows)
      const isCanvasBackground =
        e.target === containerRef.current ||
        e.target === zoomOverlayRef.current ||
        e.target === transformRef.current;
      const isGrabOnBackground =
        navMode === "grab" && e.button === 0 && isCanvasBackground;

      if (isMiddleOrSpace || isGrabOnBackground) {
        e.preventDefault();
        isPanning.current = true;
        lastPointer.current = { x: e.clientX, y: e.clientY };
        containerRef.current?.setPointerCapture(e.pointerId);
      }
    },
    [navMode],
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
        setGrabCursor(true);
        if (overlay) overlay.style.pointerEvents = "all";
      }
      if ((e.ctrlKey || e.metaKey) && overlay) {
        overlay.style.pointerEvents = "all";
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = false;
        setGrabCursor(false);
        if (!e.ctrlKey && !e.metaKey && overlay) {
          overlay.style.pointerEvents = "none";
        }
      }
      if (!e.ctrlKey && !e.metaKey && !spaceDown.current && overlay) {
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
        cursor: grabCursor || isPanning.current ? "grabbing" : navMode === "grab" ? "grab" : "default",
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
        ref={transformRef}
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
