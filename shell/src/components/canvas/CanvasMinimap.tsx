"use client";

import { useRef, useCallback, useEffect } from "react";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasGroups } from "@/stores/canvas-groups";

const SM_W = 120;
const SM_H = 84;
const LG_W = 280;
const LG_H = 196;
const MINIMAP_PADDING = 20;

interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

function computeWorldBounds(
  windows: { x: number; y: number; width: number; height: number }[],
  viewportRect: { x: number; y: number; w: number; h: number },
): WorldBounds {
  let minX = viewportRect.x;
  let minY = viewportRect.y;
  let maxX = viewportRect.x + viewportRect.w;
  let maxY = viewportRect.y + viewportRect.h;

  for (const w of windows) {
    minX = Math.min(minX, w.x);
    minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x + w.width);
    maxY = Math.max(maxY, w.y + w.height);
  }

  minX -= MINIMAP_PADDING;
  minY -= MINIMAP_PADDING;
  maxX += MINIMAP_PADDING;
  maxY += MINIMAP_PADDING;

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function CanvasMinimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);

  const dprRef = useRef(1);

  // Set canvas dimensions once on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    canvas.width = LG_W * dpr;
    canvas.height = LG_H * dpr;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = dprRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, LG_W, LG_H);

    // Background
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.roundRect(0, 0, LG_W, LG_H, 8);
    ctx.fill();

    const { zoom, panX, panY, screenToCanvas } = useCanvasTransform.getState();
    const windows = useWindowManager.getState().windows.filter((w) => !w.minimized);
    const groups = useCanvasGroups.getState().groups;

    // Viewport rect in canvas coords
    const topLeft = screenToCanvas(0, 0);
    const bottomRight = screenToCanvas(window.innerWidth, window.innerHeight);
    const viewportRect = {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };

    const world = computeWorldBounds(windows, viewportRect);
    if (world.width === 0 || world.height === 0) return;

    const scale = Math.min(
      (LG_W - 8) / world.width,
      (LG_H - 8) / world.height,
    );
    const offsetX = (LG_W - world.width * scale) / 2;
    const offsetY = (LG_H - world.height * scale) / 2;

    const toMinimap = (x: number, y: number) => ({
      x: (x - world.minX) * scale + offsetX,
      y: (y - world.minY) * scale + offsetY,
    });

    // Draw group outlines
    for (const group of groups) {
      const bounds = useCanvasGroups.getState().getGroupBounds(group.id);
      if (!bounds) continue;
      const pos = toMinimap(bounds.x, bounds.y);
      ctx.strokeStyle = group.color + "80";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(pos.x, pos.y, bounds.width * scale, bounds.height * scale);
      ctx.setLineDash([]);
    }

    // Draw window rectangles
    for (const win of windows) {
      const pos = toMinimap(win.x, win.y);
      ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
      ctx.fillRect(pos.x, pos.y, win.width * scale, win.height * scale);
      ctx.strokeStyle = "rgba(148, 163, 184, 0.8)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(pos.x, pos.y, win.width * scale, win.height * scale);
    }

    // Draw viewport indicator
    const vpPos = toMinimap(viewportRect.x, viewportRect.y);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vpPos.x, vpPos.y, viewportRect.w * scale, viewportRect.h * scale);
  }, []);

  // Redraw on store changes
  useEffect(() => {
    draw();
    const unsubTransform = useCanvasTransform.subscribe(draw);
    const unsubWindows = useWindowManager.subscribe(draw);
    const unsubGroups = useCanvasGroups.subscribe(draw);
    return () => {
      unsubTransform();
      unsubWindows();
      unsubGroups();
    };
  }, [draw]);

  const navigateToPoint = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;

      const { zoom, screenToCanvas } = useCanvasTransform.getState();
      const windows = useWindowManager.getState().windows.filter((w) => !w.minimized);
      const topLeft = screenToCanvas(0, 0);
      const bottomRight = screenToCanvas(window.innerWidth, window.innerHeight);
      const viewportRect = {
        x: topLeft.x,
        y: topLeft.y,
        w: bottomRight.x - topLeft.x,
        h: bottomRight.y - topLeft.y,
      };

      const world = computeWorldBounds(windows, viewportRect);
      if (world.width === 0 || world.height === 0) return;

      const scale = Math.min(
        (LG_W - 8) / world.width,
        (LG_H - 8) / world.height,
      );
      const offsetX = (LG_W - world.width * scale) / 2;
      const offsetY = (LG_H - world.height * scale) / 2;

      // Convert minimap coords to canvas coords
      const canvasX = (mx - offsetX) / scale + world.minX;
      const canvasY = (my - offsetY) / scale + world.minY;

      // Center viewport on this point
      const panX = window.innerWidth / (2 * zoom) - canvasX;
      const panY = window.innerHeight / (2 * zoom) - canvasY;
      useCanvasTransform.getState().setPan(panX, panY);
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      navigateToPoint(e.clientX, e.clientY);
    },
    [navigateToPoint],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      navigateToPoint(e.clientX, e.clientY);
    },
    [navigateToPoint],
  );

  return (
    <div
      className="absolute bottom-3 right-3 z-50 group/minimap"
      style={{ width: SM_W, height: SM_H }}
    >
      <canvas
        ref={canvasRef}
        width={LG_W}
        height={LG_H}
        className="absolute bottom-0 right-0 rounded-lg cursor-crosshair opacity-60 group-hover/minimap:opacity-100 transition-all duration-300 ease-out"
        style={{
          width: SM_W,
          height: SM_H,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerEnter={(e) => {
          const el = e.currentTarget;
          el.style.width = `${LG_W}px`;
          el.style.height = `${LG_H}px`;
        }}
        onPointerLeave={(e) => {
          if (isDragging.current) return;
          const el = e.currentTarget;
          el.style.width = `${SM_W}px`;
          el.style.height = `${SM_H}px`;
        }}
        onPointerUp={() => {
          isDragging.current = false;
        }}
      />
    </div>
  );
}
