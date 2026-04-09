"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvasTransform, INTERACTION_THRESHOLD } from "@/hooks/useCanvasTransform";
import { useWindowManager, type AppWindow } from "@/hooks/useWindowManager";
import { useCanvasSettings } from "@/stores/canvas-settings";
import { AppViewer } from "../AppViewer";
import { TerminalApp } from "../terminal/TerminalApp";
import { FileBrowser } from "../file-browser/FileBrowser";
import { PreviewWindow } from "../preview-window/PreviewWindow";
import { Minus, Maximize2 } from "lucide-react";

function useThemeStyle() {
  const [style, setStyle] = useState<string>("flat");
  useEffect(() => {
    const root = document.documentElement;
    setStyle(root.getAttribute("data-theme-style") ?? "flat");
    const observer = new MutationObserver(() => {
      setStyle(root.getAttribute("data-theme-style") ?? "flat");
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme-style"] });
    return () => observer.disconnect();
  }, []);
  return style;
}

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
  const maxZ = useWindowManager((s) =>
    s.windows.reduce((m, w) => (!w.minimized && w.zIndex > m ? w.zIndex : m), 0),
  );
  const isFocused = win.zIndex === maxZ;
  const showTitles = useCanvasSettings((s) => s.showTitles);
  const themeStyle = useThemeStyle();
  const isNeumorphic = themeStyle === "neumorphic";

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

  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

      // Safety: auto-clear if pointer up never fires
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = setTimeout(() => {
        dragRef.current = null;
        setInteracting(false);
      }, 5000);
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
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
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

      // Safety: auto-clear if pointer up never fires
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = setTimeout(() => {
        resizeRef.current = null;
        setInteracting(false);
      }, 5000);
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
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
  }, []);

  const titleBarHeight = 36;
  const titleBarGap = 8;

  const win98Bevel = {
    borderTop: "1.5px solid var(--neu-shadow-light)",
    borderLeft: "1.5px solid var(--neu-shadow-light)",
    borderBottom: "1.5px solid var(--neu-shadow-dark)",
    borderRight: "1.5px solid var(--neu-shadow-dark)",
  };

  const macTitleBar = (
    <div
      className="absolute cursor-grab active:cursor-grabbing select-none group/titlebar transition-all duration-200"
      style={{
        width: win.width,
        height: titleBarHeight,
        bottom: `calc(100% + ${titleBarGap}px)`,
        left: 0,
      }}
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
    >
      {/* Glass pill container */}
      <div
        className={`relative w-full h-full rounded-2xl flex items-center gap-2 px-3 overflow-hidden transition-all duration-200 backdrop-blur-xl backdrop-saturate-150 ${
          isFocused
            ? "bg-muted/80 border border-border/50 shadow-sm"
            : "bg-muted/40 border border-border/20 opacity-80"
        }`}
      >
        {/* macOS traffic lights */}
        <div className="group/traffic flex items-center gap-1.5 shrink-0 relative z-10">
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
        <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 relative z-10">
          {iconUrl ? (
            <img src={iconUrl} alt="" className="size-4 rounded-md object-cover shrink-0" draggable={false} />
          ) : (
            <span className="size-4 rounded-md bg-muted flex items-center justify-center text-[9px] font-semibold text-muted-foreground shrink-0">
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
    </div>
  );

  const win98TitleBar = (
    <div
      className="absolute cursor-grab active:cursor-grabbing select-none"
      style={{
        width: win.width,
        height: titleBarHeight,
        bottom: `calc(100% + ${titleBarGap}px)`,
        left: 0,
      }}
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
    >
      {/* Win98 raised title bar */}
      <div
        className={`relative w-full h-full flex items-center px-2 gap-2 ${
          isFocused
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground"
        }`}
        style={{
          ...win98Bevel,
          borderTopWidth: "2px",
          borderLeftWidth: "2px",
          borderBottomWidth: "2px",
          borderRightWidth: "2px",
          borderRadius: "2px",
        }}
      >
        {/* Left: icon + title */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {iconUrl ? (
            <img src={iconUrl} alt="" className="size-4 object-cover shrink-0" style={{ imageRendering: "auto" }} draggable={false} />
          ) : (
            <span className="size-4 flex items-center justify-center text-[10px] font-bold shrink-0">
              {win.title.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="text-xs font-bold truncate">
            {win.title}
          </span>
        </div>
        {/* Right: Win98 window buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            className="size-5 flex items-center justify-center text-foreground bg-muted hover:bg-muted/80 active:bg-muted/60"
            style={{
              ...win98Bevel,
              fontSize: "10px",
              lineHeight: 1,
            }}
            onClick={(e) => { e.stopPropagation(); minimizeWindow(win.id); }}
            aria-label="Minimize"
          >
            <Minus className="size-2.5" />
          </button>
          <button
            className="size-5 flex items-center justify-center text-foreground bg-muted hover:bg-muted/80 active:bg-muted/60"
            style={{
              ...win98Bevel,
              fontSize: "10px",
              lineHeight: 1,
            }}
            onClick={(e) => { e.stopPropagation(); fitWindow(); }}
            aria-label="Maximize"
          >
            <Maximize2 className="size-2.5" />
          </button>
          <button
            className="size-5 flex items-center justify-center text-foreground bg-muted hover:bg-muted/80 active:bg-muted/60"
            style={{
              ...win98Bevel,
              fontSize: "12px",
              fontWeight: 700,
              lineHeight: 1,
            }}
            onClick={(e) => { e.stopPropagation(); closeWindow(win.id); }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );

  const titleBar = showTitles ? (isNeumorphic ? win98TitleBar : macTitleBar) : null;

  // Zoomed-out preview: icon card with title bar above
  if (!isInteractive) {
    return (
      <div
        className="absolute"
        style={{ left: win.x, top: win.y, zIndex: win.zIndex, pointerEvents: "auto" }}
      >
        {titleBar}
        <div
          className={`rounded-lg bg-card overflow-hidden flex items-center justify-center transition-shadow duration-150 ${
            isFocused ? "shadow-lg ring-1 ring-primary/30" : "shadow-md opacity-80"
          }`}
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
        className={`rounded-lg bg-card overflow-hidden transition-shadow duration-150 ${
          isFocused ? "shadow-xl ring-1 ring-primary/30" : "shadow-md"
        }`}
        style={{ width: win.width, height: win.height }}
      >
        {win.path.startsWith("__terminal__") ? (
          <TerminalApp />
        ) : win.path === "__file-browser__" ? (
          <FileBrowser windowId={win.id} />
        ) : win.path === "__preview-window__" ? (
          <PreviewWindow />
        ) : win.path === "__chat__" ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">Chat</div>
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
        onPointerCancel={onResizeEnd}
      >
        <svg viewBox="0 0 12 12" className="size-3 text-muted-foreground/30">
          <path d="M11 1v10H1" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M11 5v6H5" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
