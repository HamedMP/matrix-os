"use client";

import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasLabels } from "@/stores/canvas-labels";
import { Minus, Plus, Maximize, Type, LayoutGrid, Grid3X3, MousePointer, Hand, Eye, EyeOff, CircleHelpIcon } from "lucide-react";
import { useDotGrid } from "../DotGrid";
import { useCanvasSettings } from "@/stores/canvas-settings";
import { autoArrangeWindows } from "./canvas-auto-arrange";

interface CanvasToolbarProps {
  guideVisible?: boolean;
  onOpenGuide?: () => void;
}

export function CanvasToolbar({ guideVisible = false, onOpenGuide }: CanvasToolbarProps = {}) {
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

  const onFitAll = () => {
    const windows = useWindowManager.getState().windows.filter((w) => !w.minimized);
    const cRect = useCanvasTransform.getState().containerRect;
    fitAll(
      windows.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
      cRect?.width ?? window.innerWidth,
      cRect?.height ?? window.innerHeight,
    );
  };

  const createLabel = useCanvasLabels((s) => s.createLabel);
  const screenToCanvas = useCanvasTransform((s) => s.screenToCanvas);

  const onAddLabel = () => {
    const cRect = useCanvasTransform.getState().containerRect;
    const cx = (cRect?.left ?? 0) + (cRect?.width ?? window.innerWidth) / 2;
    const cy = (cRect?.top ?? 0) + (cRect?.height ?? window.innerHeight) / 2;
    const center = screenToCanvas(cx, cy);
    createLabel("Label", center.x, center.y);
  };

  const onSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setZoom(parseFloat(e.target.value));
  };

  return (
    <>
      <button
        type="button"
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
        type="button"
        onClick={zoomIn}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Zoom in"
        title="Zoom in (Cmd+=)"
      >
        <Plus className="size-3.5" />
      </button>

      <button
        type="button"
        onClick={() => resetZoom()}
        className="px-1.5 py-0.5 text-xs font-mono rounded hover:bg-muted transition-colors min-w-[3rem] text-center"
        title="Reset to 100% (Cmd+1)"
      >
        {Math.round(zoom * 100)}%
      </button>

      <div className="w-px h-4 bg-border" />

      <button
        type="button"
        onClick={onFitAll}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Fit all"
        title="Fit all windows (Cmd+0)"
      >
        <Maximize className="size-3.5" />
      </button>

      <button
        type="button"
        onClick={autoArrangeWindows}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Auto-align apps"
        title="Auto-align apps (Cmd+Shift+K)"
      >
        <LayoutGrid className="size-3.5" />
      </button>

      <div className="w-px h-4 bg-border" />

      <button
        type="button"
        onClick={onAddLabel}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Add text label"
        title="Add text label (double-click canvas)"
      >
        <Type className="size-3.5" />
      </button>

      <button
        type="button"
        onClick={toggleGrid}
        className={`p-1 rounded transition-colors ${gridEnabled ? "bg-muted text-foreground" : "hover:bg-muted text-muted-foreground"}`}
        aria-label="Toggle dot grid"
        title="Toggle dot grid"
      >
        <Grid3X3 className="size-3.5" />
      </button>

      <button
        type="button"
        onClick={toggleShowTitles}
        className={`p-1 rounded transition-colors ${showTitles ? "bg-muted text-foreground" : "hover:bg-muted text-muted-foreground"}`}
        aria-label="Toggle app titles"
        title={showTitles ? "Hide app titles" : "Show app titles"}
      >
        {showTitles ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>

      <div className="w-px h-4 bg-border" />

      {onOpenGuide && (
        <>
          <button
            type="button"
            onClick={onOpenGuide}
            className={`p-1 rounded transition-colors ${guideVisible ? "bg-muted text-foreground" : "hover:bg-muted text-muted-foreground"}`}
            aria-label="Show get started guide"
            title="Show get started guide"
          >
            <CircleHelpIcon className="size-3.5" />
          </button>
          <div className="w-px h-4 bg-border" />
        </>
      )}

      <div className="flex items-center rounded-md bg-muted/50 p-0.5 gap-0.5">
        <button
          type="button"
          onClick={() => setNavMode("scroll")}
          className={`p-1 rounded transition-colors ${navMode === "scroll" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          aria-label="Scroll to navigate"
          title="Scroll to navigate"
        >
          <MousePointer className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setNavMode("grab")}
          className={`p-1 rounded transition-colors ${navMode === "grab" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          aria-label="Click and drag to navigate"
          title="Click and drag to navigate"
        >
          <Hand className="size-3.5" />
        </button>
      </div>
    </>
  );
}
