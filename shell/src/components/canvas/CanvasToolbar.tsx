"use client";

import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasLabels } from "@/stores/canvas-labels";
import { Minus, Plus, Maximize, Type, LayoutGrid, Grid3X3, MousePointer, Hand, Eye, EyeOff, CircleHelpIcon, EllipsisIcon, CheckIcon } from "@/lib/hugeicons";
import { useDotGrid } from "../DotGrid";
import { useCanvasSettings } from "@/stores/canvas-settings";
import { autoArrangeWindows } from "./canvas-auto-arrange";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

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

      <button
        type="button"
        onClick={() => resetZoom()}
        className="min-w-[3rem] rounded px-1.5 py-0.5 text-center font-mono text-xs transition-colors hover:bg-muted"
        aria-label="Reset zoom to 100%"
        title="Reset to 100% (Cmd+1)"
      >
        {Math.round(zoom * 100)}%
      </button>

      <button
        type="button"
        onClick={zoomIn}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Zoom in"
        title="Zoom in (Cmd+=)"
      >
        <Plus className="size-3.5" />
      </button>

      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={0.01}
        value={zoom}
        onChange={onSliderChange}
        className="hidden h-1 w-24 cursor-pointer accent-primary lg:block"
        aria-label="Zoom level"
      />

      <div className="h-4 w-px shrink-0 bg-border" />

      <button
        type="button"
        onClick={onFitAll}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label="Fit all"
        title="Fit all windows (Cmd+0)"
      >
        <Maximize className="size-3.5" />
      </button>

      <div data-testid="full-canvas-actions" className="hidden items-center gap-0.5 lg:flex">
        <button
          type="button"
          onClick={autoArrangeWindows}
          className="p-1 rounded hover:bg-muted transition-colors"
          aria-label="Auto-align apps"
          title="Auto-align apps (Cmd+Shift+K)"
        >
          <LayoutGrid className="size-3.5" />
        </button>

        <div className="h-4 w-px shrink-0 bg-border" />

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
          aria-pressed={gridEnabled}
          title="Toggle dot grid"
        >
          <Grid3X3 className="size-3.5" />
        </button>

        <button
          type="button"
          onClick={toggleShowTitles}
          className={`p-1 rounded transition-colors ${showTitles ? "bg-muted text-foreground" : "hover:bg-muted text-muted-foreground"}`}
          aria-label="Toggle app titles"
          aria-pressed={showTitles}
          title={showTitles ? "Hide app titles" : "Show app titles"}
        >
          {showTitles ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </button>

        {onOpenGuide ? (
          <>
            <div className="h-4 w-px shrink-0 bg-border" />
            <button
              type="button"
              onClick={onOpenGuide}
              className={`p-1 rounded transition-colors ${guideVisible ? "bg-muted text-foreground" : "hover:bg-muted text-muted-foreground"}`}
              aria-label="Show get started guide"
              title="Show get started guide"
            >
              <CircleHelpIcon className="size-3.5" />
            </button>
          </>
        ) : null}
      </div>

      <div data-testid="compact-canvas-actions" className="shrink-0 lg:hidden">
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label="More canvas controls"
              title="More canvas controls"
              className="flex size-6 items-center justify-center rounded transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <EllipsisIcon className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              aria-label="More canvas controls"
              align="center"
              sideOffset={4}
              collisionPadding={8}
              className="z-[70] min-w-52 rounded-lg border border-border/40 bg-card/95 py-1 text-[13px] leading-normal text-foreground/80 shadow-xl backdrop-blur-xl"
            >
              <DropdownMenuPrimitive.Item onSelect={autoArrangeWindows} className="flex cursor-default select-none items-center gap-2 px-3 py-1 outline-none data-[highlighted]:bg-primary/10 data-[highlighted]:text-foreground">
                <LayoutGrid className="size-3.5" aria-hidden="true" />
                Auto-align apps
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item onSelect={onAddLabel} className="flex cursor-default select-none items-center gap-2 px-3 py-1 outline-none data-[highlighted]:bg-primary/10 data-[highlighted]:text-foreground">
                <Type className="size-3.5" aria-hidden="true" />
                Add text label
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border/40" />
              <DropdownMenuPrimitive.CheckboxItem
                checked={gridEnabled}
                onCheckedChange={toggleGrid}
                className="relative flex cursor-default select-none items-center gap-2 py-1 pl-8 pr-3 outline-none data-[highlighted]:bg-primary/10 data-[highlighted]:text-foreground"
              >
                <DropdownMenuPrimitive.ItemIndicator className="absolute left-3 inline-flex items-center">
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                </DropdownMenuPrimitive.ItemIndicator>
                Show dot grid
              </DropdownMenuPrimitive.CheckboxItem>
              <DropdownMenuPrimitive.CheckboxItem
                checked={showTitles}
                onCheckedChange={toggleShowTitles}
                className="relative flex cursor-default select-none items-center gap-2 py-1 pl-8 pr-3 outline-none data-[highlighted]:bg-primary/10 data-[highlighted]:text-foreground"
              >
                <DropdownMenuPrimitive.ItemIndicator className="absolute left-3 inline-flex items-center">
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                </DropdownMenuPrimitive.ItemIndicator>
                Show app titles
              </DropdownMenuPrimitive.CheckboxItem>
              {onOpenGuide ? (
                <>
                  <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border/40" />
                  <DropdownMenuPrimitive.Item onSelect={onOpenGuide} className="flex cursor-default select-none items-center gap-2 px-3 py-1 outline-none data-[highlighted]:bg-primary/10 data-[highlighted]:text-foreground">
                    <CircleHelpIcon className="size-3.5" aria-hidden="true" />
                    Show get started guide
                  </DropdownMenuPrimitive.Item>
                </>
              ) : null}
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
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
