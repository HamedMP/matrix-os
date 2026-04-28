"use client";

import { useRef, useCallback, useEffect, useState, type ReactNode } from "react";
import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX } from "@/hooks/useCanvasTransform";
import { useCanvasSettings } from "@/stores/canvas-settings";

interface CanvasTransformProps {
  children: ReactNode;
  className?: string;
  onDoubleClick?: (e: React.MouseEvent) => void;
  panEnabled?: boolean;
  onBackgroundPointerDown?: () => void;
}

export function CanvasTransform({
  children,
  className,
  onDoubleClick,
  panEnabled = true,
  onBackgroundPointerDown,
}: CanvasTransformProps) {
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
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointer = useRef({ x: 0, y: 0 });
  const spaceDown = useRef(false);
  const [grabCursor, setGrabCursor] = useState(false);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!panEnabled) return;

      e.preventDefault();

      // Disable pointer events on children while scrolling so iframes/app
      // windows don't capture the scroll mid-pan. Only write DOM on transition.
      const state = useCanvasTransform.getState();
      if (!state.isScrolling) {
        if (transformRef.current) transformRef.current.style.pointerEvents = "none";
        state.setIsScrolling(true);
      }
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => {
        useCanvasTransform.getState().setIsScrolling(false);
        if (transformRef.current && !useCanvasTransform.getState().isAnimating) {
          transformRef.current.style.pointerEvents = "auto";
        }
      }, 150);

      if (e.ctrlKey || e.metaKey) {
        const delta = -e.deltaY * 0.01;
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + delta));
        zoomAtPoint(newZoom, e.clientX, e.clientY);
      } else if (navMode === "scroll") {
        panBy(-e.deltaX / zoom, -e.deltaY / zoom);
      }
    },
    [zoom, zoomAtPoint, panBy, navMode, panEnabled],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const isMiddleOrSpace = e.button === 1 || (e.button === 0 && spaceDown.current);
      const isCanvasBackground =
        e.target === containerRef.current ||
        e.target === zoomOverlayRef.current ||
        e.target === transformRef.current;
      if (isCanvasBackground) {
        onBackgroundPointerDown?.();
      }
      const isGrabOnBackground =
        navMode === "grab" && e.button === 0 && isCanvasBackground;

      if (panEnabled && (isMiddleOrSpace || isGrabOnBackground)) {
        e.preventDefault();
        isPanning.current = true;
        lastPointer.current = { x: e.clientX, y: e.clientY };
        containerRef.current?.setPointerCapture(e.pointerId);
      }
    },
    [navMode, onBackgroundPointerDown, panEnabled],
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

  // Listen for zoom events forwarded from iframes via postMessage.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "os:wheel-zoom") return;
      if (!panEnabled) return;
      const { deltaY, clientX, clientY } = e.data;
      const iframes = document.querySelectorAll("iframe");
      let parentX = clientX;
      let parentY = clientY;
      for (const iframe of iframes) {
        if (iframe.contentWindow === e.source) {
          const rect = iframe.getBoundingClientRect();
          parentX = rect.left + clientX;
          parentY = rect.top + clientY;
          break;
        }
      }
      const delta = -deltaY * 0.01;
      const { zoom: z, zoomAtPoint: zap } = useCanvasTransform.getState();
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta));
      zap(newZoom, parentX, parentY);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [panEnabled]);

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

    const resetOverlay = () => {
      spaceDown.current = false;
      setGrabCursor(false);
      if (overlay) overlay.style.pointerEvents = "none";
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") resetOverlay();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", resetOverlay);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", resetOverlay);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
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
