"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCanvasTransform, INTERACTION_THRESHOLD } from "@/hooks/useCanvasTransform";
import { useWindowManager, type AppWindow } from "@/hooks/useWindowManager";
import { useCanvasSettings } from "@/stores/canvas-settings";
import { AppViewer } from "../AppViewer";
import { TerminalApp } from "../terminal/TerminalApp";
import { FileBrowser } from "../file-browser/FileBrowser";
import { PreviewWindow } from "../preview-window/PreviewWindow";
import { WorkspaceApp } from "../workspace/WorkspaceApp";
import { ChatApp } from "../ChatApp";
import { useChatContext } from "@/stores/chat-context";
import { Minus, Maximize2, ExternalLink } from "lucide-react";
import { openAppInStandaloneTab } from "@/lib/open-app-tab";

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
  /** When true, the window stays mounted but is visually hidden so iframe
      state, terminal sockets, and React state survive minimize -> restore. */
  hidden?: boolean;
}

export function CanvasWindow({ win, hidden = false }: CanvasWindowProps) {
  const chatState = useChatContext();
  const zoom = useCanvasTransform((s) => s.zoom);
  const panX = useCanvasTransform((s) => s.panX);
  const panY = useCanvasTransform((s) => s.panY);
  const fitAll = useCanvasTransform((s) => s.fitAll);
  const closeWindow = useWindowManager((s) => s.closeWindow);
  const minimizeWindow = useWindowManager((s) => s.minimizeWindow);
  const focusWindow = useWindowManager((s) => s.focusWindow);
  const moveWindow = useWindowManager((s) => s.moveWindow);
  const resizeWindow = useWindowManager((s) => s.resizeWindow);
  const focusedWindowId = useWindowManager((s) => s.focusedWindowId);
  const fullscreenWindowId = useWindowManager((s) => s.fullscreenWindowId);
  const iconUrl = useWindowManager((s) => s.apps.find((a) => a.path === win.path)?.iconUrl);
  const isFocused = focusedWindowId === win.id;
  const isFullscreen = fullscreenWindowId === win.id;
  const showTitles = useCanvasSettings((s) => s.showTitles);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const themeStyle = useThemeStyle();
  const isNeumorphic = themeStyle === "neumorphic";

  const fitWindow = useCallback(() => {
    fitAll(
      [{ x: win.x, y: win.y, width: win.width, height: win.height }],
      window.innerWidth,
      window.innerHeight,
    );
  }, [fitAll, win.x, win.y, win.width, win.height]);

  const stopTitleBarPointer = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
  }, []);

  const openStandaloneTab = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    openAppInStandaloneTab(win.path);
  }, [win.path]);

  const [interacting, setInteracting] = useState(false);
  const isInteractive = zoom >= INTERACTION_THRESHOLD;
  const inverseScale = 1 / zoom;

  // Iframe windows get a "click-to-interact" overlay so wheel events reach
  // the canvas instead of being swallowed by the iframe's browsing context.
  const isIframeWindow = !win.path.startsWith("__");
  const isCanvasScrolling = useCanvasTransform((s) => s.isScrolling);
  const [contentFocused, setContentFocused] = useState(false);

  useEffect(() => {
    if (isCanvasScrolling || !isFocused) setContentFocused(false);
  }, [isCanvasScrolling, isFocused]);

  // Fullscreen: set overflow visible on ancestor containers so the window
  // can extend beyond the canvas area to cover the full viewport, and raise
  // z-index so it paints above the dock and other siblings.
  // Also measure the canvas container's viewport offset for positioning.
  const [containerOffset, setContainerOffset] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!isFullscreen) return;
    const el = wrapperRef.current;
    if (!el) return;

    const saved: { el: HTMLElement; overflow: string; zIndex: string }[] = [];
    let canvasContainer: HTMLElement | null = null;
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const cs = getComputedStyle(parent);
      saved.push({ el: parent, overflow: parent.style.overflow, zIndex: parent.style.zIndex });
      if (cs.overflow === "hidden") {
        parent.style.overflow = "visible";
        if (!canvasContainer) canvasContainer = parent;
      }
      if (cs.position !== "static") parent.style.zIndex = "100";
      parent = parent.parentElement;
    }

    const measure = () => {
      if (canvasContainer) {
        const r = canvasContainer.getBoundingClientRect();
        setContainerOffset({ x: r.left, y: r.top });
      }
    };
    measure();
    window.addEventListener("resize", measure);

    return () => {
      window.removeEventListener("resize", measure);
      for (const s of saved) {
        s.el.style.overflow = s.overflow;
        s.el.style.zIndex = s.zIndex;
      }
    };
  }, [isFullscreen]);

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
            onClick={(e) => { e.stopPropagation(); useWindowManager.getState().toggleFullscreen(win.id); }}
            aria-label="Fullscreen"
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
        <div className="w-[42px] shrink-0 flex justify-end">
          {isIframeWindow && (
            <button
              className="size-6 rounded-md flex items-center justify-center text-foreground/60 hover:text-foreground hover:bg-background/70 transition-colors"
              onPointerDown={stopTitleBarPointer}
              onClick={openStandaloneTab}
              aria-label="Open in new tab"
              title="Open in new tab"
            >
              <ExternalLink className="size-3.5" />
            </button>
          )}
        </div>
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
          {isIframeWindow && (
            <button
              className="size-5 flex items-center justify-center text-foreground bg-muted hover:bg-muted/80 active:bg-muted/60"
              style={{
                ...win98Bevel,
                fontSize: "10px",
                lineHeight: 1,
              }}
              onPointerDown={stopTitleBarPointer}
              onClick={openStandaloneTab}
              aria-label="Open in new tab"
              title="Open in new tab"
            >
              <ExternalLink className="size-2.5" />
            </button>
          )}
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
            onClick={(e) => { e.stopPropagation(); useWindowManager.getState().toggleFullscreen(win.id); }}
            aria-label="Fullscreen"
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

  const titleBarInner = isNeumorphic ? win98TitleBar : macTitleBar;
  const titleBar = (
    <div
      style={{
        opacity: showTitles ? 1 : 0,
        transform: showTitles ? "translateY(0)" : "translateY(4px)",
        transition: "opacity 260ms cubic-bezier(0.22, 1, 0.36, 1), transform 260ms cubic-bezier(0.22, 1, 0.36, 1)",
        pointerEvents: showTitles ? undefined : "none",
      }}
    >
      {titleBarInner}
    </div>
  );

  // Zoomed-out preview: icon card with title bar above.
  // Skip preview if fullscreen — always render interactive content.
  const isPreview = !isInteractive && !isFullscreen;

  // Fullscreen: compute inverse-transform position so this element
  // (which lives inside the canvas transform div) fills the viewport.
  // Parent CSS: scale(zoom) translate(panX, panY), transformOrigin 0 0
  // With counter-transform scale(1/zoom) on this element, CSS pixels = screen pixels.
  const contLeft = containerOffset.x;
  const contTop = containerOffset.y;
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;

  const wrapperStyle: React.CSSProperties = isFullscreen
    ? {
        left: -contLeft / zoom - panX,
        top: -contTop / zoom - panY,
        zIndex: 9999,
        transform: `scale(${1 / zoom})`,
        transformOrigin: "0 0",
      }
    : {
        left: win.x,
        top: win.y,
        zIndex: win.zIndex,
        pointerEvents: isPreview ? "auto" : undefined,
        display: hidden ? "none" : undefined,
      };

  const contentStyle: React.CSSProperties = isFullscreen
    ? { width: vw, height: vh }
    : { width: win.width, height: win.height };

  const appContent = (
    <>
      {win.path.startsWith("__terminal__") ? (
        <TerminalApp />
      ) : win.path === "__workspace__" ? (
        <WorkspaceApp />
      ) : win.path === "__file-browser__" ? (
        <FileBrowser windowId={win.id} />
      ) : win.path === "__preview-window__" ? (
        <PreviewWindow />
      ) : win.path === "__chat__" ? (
        <div className="h-full overflow-hidden">
          {chatState && (
            <ChatApp
              messages={chatState.messages}
              sessionId={chatState.sessionId}
              busy={chatState.busy}
              connected={chatState.connected}
              conversations={chatState.conversations}
              onNewChat={chatState.newChat}
              onSwitchConversation={chatState.switchConversation}
              onSubmit={chatState.submitMessage}
            />
          )}
        </div>
      ) : (
        <AppViewer path={win.path} />
      )}
    </>
  );

  return (
    <div
      ref={wrapperRef}
      className="absolute"
      data-canvas-window={!isPreview || undefined}
      style={wrapperStyle}
      onMouseDown={isFullscreen ? undefined : () => focusWindow(win.id)}
    >
      {!isFullscreen && titleBar}
      <div
        className={isFullscreen
          ? "bg-background overflow-hidden"
          : isPreview
            ? `rounded-lg bg-card overflow-hidden flex items-center justify-center transition-shadow duration-150 ${
                isFocused ? "shadow-lg ring-1 ring-primary/30" : "shadow-md opacity-80"
              }`
            : `rounded-lg bg-card overflow-hidden transition-shadow duration-150 ${
                isFocused ? "shadow-xl ring-1 ring-primary/30" : "shadow-md"
              }`
        }
        style={contentStyle}
      >
        {isPreview ? (
          <>
            {iconUrl ? (
              <img src={iconUrl} alt={win.title} className="size-16 object-contain opacity-50" draggable={false} />
            ) : (
              <span className="text-3xl font-semibold text-muted-foreground/20">
                {win.title.charAt(0).toUpperCase()}
              </span>
            )}
          </>
        ) : (
          <>
            {appContent}
            {!isFullscreen && interacting && <div className="absolute inset-0 z-10" />}
            {!isFullscreen && !contentFocused && !interacting && (
              <div
                className="absolute inset-0 z-10"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setContentFocused(true);
                  focusWindow(win.id);
                }}
              />
            )}
          </>
        )}
      </div>
      {/* Resize handle — hidden in fullscreen and preview */}
      {!isFullscreen && !isPreview && (
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
      )}
    </div>
  );
}
