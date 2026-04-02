"use client";

import { useCallback, useRef, useState } from "react";
import { useCanvasTransform, INTERACTION_THRESHOLD } from "@/hooks/useCanvasTransform";
import { useWindowManager, type AppWindow } from "@/hooks/useWindowManager";
import { useCanvasSettings } from "@/stores/canvas-settings";
import { AppViewer } from "../AppViewer";
import { TerminalApp } from "../terminal/TerminalApp";
import { FileBrowser } from "../file-browser/FileBrowser";
import { PreviewWindow } from "../preview-window/PreviewWindow";
import { Minus, Maximize2 } from "lucide-react";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

interface CanvasWindowProps {
  win: AppWindow;
}

export function CanvasWindow({ win }: CanvasWindowProps) {
  const zoom = useCanvasTransform((s) => s.zoom);
  const fitAll = useCanvasTransform((s) => s.fitAll);
  const closeWindow = useWindowManager((s) => s.closeWindow);
  const minimizeWindow = useWindowManager((s) => s.minimizeWindow);
  const focusWindow = useWindowManager((s) => s.focusWindow);
  const moveWindow = useWindowManager((s) => s.moveWindow);
  const resizeWindow = useWindowManager((s) => s.resizeWindow);
  const iconUrl = useWindowManager((s) => s.apps.find((a) => a.path === win.path)?.iconUrl);
  const showTitles = useCanvasSettings((s) => s.showTitles);

  const fitWindow = useCallback(() => {
    fitAll(
      [{ x: win.x, y: win.y, width: win.width, height: win.height }],
      window.innerWidth,
      window.innerHeight,
    );
  }, [fitAll, win.x, win.y, win.width, win.height]);

  const [interacting, setInteracting] = useState(false);
  const isInteractive = zoom >= INTERACTION_THRESHOLD;
  const inverseScale = 1 / zoom;

  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const resizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: win.x,
        origY: win.y,
      };
      setInteracting(true);
      focusWindow(win.id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [win.x, win.y, win.id, focusWindow],
  );

  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const { startX, startY, origX, origY } = dragRef.current;
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      moveWindow(win.id, origX + dx, origY + dy);
    },
    [win.id, zoom, moveWindow],
  );

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setInteracting(false);
  }, []);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origW: win.width,
        origH: win.height,
      };
      setInteracting(true);
      focusWindow(win.id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [win.width, win.height, win.id, focusWindow],
  );

  const onResizeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return;
      const { startX, startY, origW, origH } = resizeRef.current;
      const dw = (e.clientX - startX) / zoom;
      const dh = (e.clientY - startY) / zoom;
      resizeWindow(
        win.id,
        Math.max(MIN_WIDTH, origW + dw),
        Math.max(MIN_HEIGHT, origH + dh),
      );
    },
    [win.id, zoom, resizeWindow],
  );

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
    setInteracting(false);
  }, []);

  const titleBarHeight = 32;
  const titleBar = showTitles ? (
    <div
      className="absolute flex items-center gap-1.5 px-2.5 rounded-t-lg bg-muted/60 border-b border-border/40 cursor-grab active:cursor-grabbing select-none group/titlebar"
      style={{
        transform: `scale(${inverseScale})`,
        transformOrigin: "bottom left",
        width: win.width * zoom,
        height: titleBarHeight,
        bottom: "100%",
        left: 0,
      }}
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
    >
      {/* macOS traffic lights */}
      <div className="group/traffic flex items-center gap-1.5 shrink-0">
        <button
          className="size-3 rounded-full bg-[#ff5f57] flex items-center justify-center hover:brightness-90 transition-colors"
          onClick={(e) => { e.stopPropagation(); closeWindow(win.id); }}
          aria-label="Close"
        >
          <span className="text-[8px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
            x
          </span>
        </button>
        <button
          className="size-3 rounded-full bg-[#febc2e] flex items-center justify-center hover:brightness-90 transition-colors"
          onClick={(e) => { e.stopPropagation(); minimizeWindow(win.id); }}
          aria-label="Minimize"
        >
          <span className="text-[9px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
            -
          </span>
        </button>
        <button
          className="size-3 rounded-full bg-[#28c840] flex items-center justify-center hover:brightness-90 transition-colors"
          onClick={(e) => { e.stopPropagation(); fitWindow(); }}
          aria-label="Maximize"
        >
          <Maximize2 className="size-1.5 text-black/0 group-hover/traffic:text-black/60 transition-colors" />
        </button>
      </div>
      {/* Centered title with icon */}
      <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0">
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-4 rounded object-cover shrink-0" draggable={false} />
        ) : (
          <span className="size-4 rounded bg-muted flex items-center justify-center text-[9px] font-semibold text-muted-foreground shrink-0">
            {win.title.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="text-xs font-medium text-foreground/70 truncate">
          {win.title}
        </span>
      </div>
      {/* Spacer to balance the traffic lights */}
      <div className="w-[42px] shrink-0" />
    </div>
  ) : null;

  // Zoomed-out preview: icon card with title bar above
  if (!isInteractive) {
    return (
      <div
        className="absolute"
        style={{ left: win.x, top: win.y, zIndex: win.zIndex, pointerEvents: "auto" }}
      >
        {titleBar}
        <div
          className="rounded-lg bg-card overflow-hidden shadow-md flex items-center justify-center"
          style={{ width: win.width, height: win.height }}
        >
          {iconUrl ? (
            <img src={iconUrl} alt={win.title} className="size-16 object-contain opacity-50" draggable={false} />
          ) : (
            <span className="text-3xl font-semibold text-muted-foreground/20">
              {win.title.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Zoomed-in interactive: title bar above, content below
  return (
    <div
      className="absolute"
      style={{ left: win.x, top: win.y, zIndex: win.zIndex }}
      onMouseDown={() => focusWindow(win.id)}
    >
      {titleBar}
      <div
        className="rounded-lg bg-card overflow-hidden shadow-lg"
        style={{ width: win.width, height: win.height }}
      >
        {win.path.startsWith("__terminal__") ? (
          <TerminalApp />
        ) : win.path === "__file-browser__" ? (
          <FileBrowser windowId={win.id} />
        ) : win.path === "__preview-window__" ? (
          <PreviewWindow />
        ) : (
          <AppViewer path={win.path} />
        )}
        {interacting && <div className="absolute inset-0 z-10" />}
      </div>
      {/* Resize handle */}
      <div
        className="absolute bottom-0 right-0 size-3 cursor-se-resize touch-none z-20"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
      >
        <svg viewBox="0 0 12 12" className="size-3 text-muted-foreground/30">
          <path d="M11 1v10H1" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M11 5v6H5" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
