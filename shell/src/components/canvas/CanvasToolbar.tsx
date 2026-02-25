"use client";

import { useCallback } from "react";
import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasLabels } from "@/stores/canvas-labels";
import { Minus, Plus, Maximize, Type } from "lucide-react";

export function CanvasToolbar() {
  const zoom = useCanvasTransform((s) => s.zoom);
  const zoomIn = useCanvasTransform((s) => s.zoomIn);
  const zoomOut = useCanvasTransform((s) => s.zoomOut);
  const setZoom = useCanvasTransform((s) => s.setZoom);
  const resetZoom = useCanvasTransform((s) => s.resetZoom);
  const fitAll = useCanvasTransform((s) => s.fitAll);

  const onFitAll = useCallback(() => {
    const windows = useWindowManager.getState().windows.filter((w) => !w.minimized);
    fitAll(
      windows.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
      window.innerWidth,
      window.innerHeight,
    );
  }, [fitAll]);

  const createLabel = useCanvasLabels((s) => s.createLabel);
  const screenToCanvas = useCanvasTransform((s) => s.screenToCanvas);

  const onAddLabel = useCallback(() => {
    const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
    createLabel("Label", center.x, center.y);
  }, [screenToCanvas, createLabel]);

  const onSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setZoom(parseFloat(e.target.value));
    },
    [setZoom],
  );

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-card/90 backdrop-blur-sm border border-border shadow-lg">
      <button
        onClick={zoomOut}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Zoom out"
        title="Zoom out (Cmd+-)"
      >
        <Minus className="size-3.5" />
      </button>

      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={0.01}
        value={zoom}
        onChange={onSliderChange}
        className="w-24 h-1 accent-primary cursor-pointer"
        aria-label="Zoom level"
      />

      <button
        onClick={zoomIn}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Zoom in"
        title="Zoom in (Cmd+=)"
      >
        <Plus className="size-3.5" />
      </button>

      <button
        onClick={() => resetZoom()}
        className="px-1.5 py-0.5 text-xs font-mono rounded hover:bg-muted transition-colors min-w-[3rem] text-center"
        title="Reset to 100% (Cmd+1)"
      >
        {Math.round(zoom * 100)}%
      </button>

      <div className="w-px h-4 bg-border" />

      <button
        onClick={onFitAll}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Fit all"
        title="Fit all windows (Cmd+0)"
      >
        <Maximize className="size-3.5" />
      </button>

      <div className="w-px h-4 bg-border" />

      <button
        onClick={onAddLabel}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Add text label"
        title="Add text label (double-click canvas)"
      >
        <Type className="size-3.5" />
      </button>
    </div>
  );
}
