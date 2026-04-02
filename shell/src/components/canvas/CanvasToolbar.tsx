"use client";

import { useCallback } from "react";
import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasLabels } from "@/stores/canvas-labels";
import { Minus, Plus, Maximize, Type, LayoutGrid, Grid3X3, MousePointer, Hand, Eye, EyeOff } from "lucide-react";
import { useDotGrid } from "../DotGrid";
import { useCanvasSettings } from "@/stores/canvas-settings";

export function autoArrangeWindows() {
  const wm = useWindowManager.getState();
  const wins = wm.windows.filter((w) => !w.minimized);
  if (wins.length === 0) return;

  const sorted = [...wins].sort((a, b) => {
    const rowA = Math.round(a.y / 200);
    const rowB = Math.round(b.y / 200);
    if (rowA !== rowB) return rowA - rowB;
    return a.x - b.x;
  });

  const gap = 24;
  const viewW = window.innerWidth;
  const avgWidth = sorted.reduce((s, w) => s + w.width, 0) / sorted.length;
  const cols = Math.max(1, Math.min(sorted.length, Math.floor((viewW * 0.8) / (avgWidth + gap))));

  const rows: typeof sorted[] = [];
  for (let i = 0; i < sorted.length; i += cols) {
    rows.push(sorted.slice(i, i + cols));
  }

  let currentY = gap;
  for (const row of rows) {
    const totalWidth = row.reduce((s, w) => s + w.width, 0) + (row.length - 1) * gap;
    let currentX = -totalWidth / 2;
    let rowHeight = 0;

    for (const win of row) {
      wm.moveWindow(win.id, currentX, currentY);
      currentX += win.width + gap;
      rowHeight = Math.max(rowHeight, win.height);
    }

    currentY += rowHeight + gap;
  }

  const arranged = useWindowManager.getState().windows.filter((w) => !w.minimized);
  useCanvasTransform.getState().fitAll(
    arranged.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
    window.innerWidth,
    window.innerHeight,
  );
}

export function CanvasToolbar() {
  const zoom = useCanvasTransform((s) => s.zoom);
  const zoomIn = useCanvasTransform((s) => s.zoomIn);
  const zoomOut = useCanvasTransform((s) => s.zoomOut);
  const setZoom = useCanvasTransform((s) => s.setZoom);
  const resetZoom = useCanvasTransform((s) => s.resetZoom);
  const fitAll = useCanvasTransform((s) => s.fitAll);
  const gridEnabled = useDotGrid((s) => s.enabled);
  const toggleGrid = useDotGrid((s) => s.toggle);
  const navMode = useCanvasSettings((s) => s.navMode);
  const setNavMode = useCanvasSettings((s) => s.setNavMode);
  const showTitles = useCanvasSettings((s) => s.showTitles);
  const toggleShowTitles = useCanvasSettings((s) => s.toggleShowTitles);

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

      <button
        onClick={autoArrangeWindows}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Auto-align apps"
        title="Auto-align apps (Cmd+Shift+K)"
      >
        <LayoutGrid className="size-3.5" />
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

      <button
        onClick={toggleGrid}
        className={`p-1 rounded transition-colors ${gridEnabled ? "bg-muted text-foreground" : "hover:bg-muted text-muted-foreground"}`}
        aria-label="Toggle dot grid"
        title="Toggle dot grid"
      >
        <Grid3X3 className="size-3.5" />
      </button>

      <button
        onClick={toggleShowTitles}
        className={`p-1 rounded transition-colors ${showTitles ? "bg-muted text-foreground" : "hover:bg-muted text-muted-foreground"}`}
        aria-label="Toggle app titles"
        title={showTitles ? "Hide app titles" : "Show app titles"}
      >
        {showTitles ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>

      <div className="w-px h-4 bg-border" />

      <div className="flex items-center rounded-md bg-muted/50 p-0.5 gap-0.5">
        <button
          onClick={() => setNavMode("scroll")}
          className={`p-1 rounded transition-colors ${navMode === "scroll" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          aria-label="Scroll to navigate"
          title="Scroll to navigate"
        >
          <MousePointer className="size-3.5" />
        </button>
        <button
          onClick={() => setNavMode("grab")}
          className={`p-1 rounded transition-colors ${navMode === "grab" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          aria-label="Click and drag to navigate"
          title="Click and drag to navigate"
        >
          <Hand className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
