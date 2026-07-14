"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCanvasTransform, INTERACTION_THRESHOLD } from "@/hooks/useCanvasTransform";
import { useWindowManager, type AppWindow } from "@/hooks/useWindowManager";
import { useMobileViewport } from "@/hooks/useMobileViewport";
import { useCanvasSettings } from "@/stores/canvas-settings";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { nativeAppIdFromPath } from "@/lib/native-apps";
import { AppViewer } from "../AppViewer";
import { NativeAppViewer } from "../NativeAppViewer";
import { TerminalApp } from "../terminal/TerminalApp";
import { FileBrowser } from "../file-browser/FileBrowser";
import { PreviewWindow } from "../preview-window/PreviewWindow";
import { WorkspaceApp } from "../workspace/WorkspaceApp";
import { ChatApp } from "../ChatApp";
import { ActivityMonitorApp } from "../system-activity/ActivityMonitorApp";
import { useChatContext } from "@/stores/chat-context";
import { TrafficLights } from "../window/TrafficLights";
import { Minus, Maximize2 } from "lucide-react";

function useThemeStyle() {
  const [style, setStyle] = useState<string>("flat");
  useEffect(() => {
    const root = document.documentElement;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-initialize-state -- syncs from an external DOM source: the `data-theme-style` attribute is mutated outside React (by the theme system) and is not derivable in render; the mount read + MutationObserver mirror is the canonical external-store subscription
    setStyle(root.getAttribute("data-theme-style") ?? "flat");
    const observer = new MutationObserver(() => {
      setStyle(root.getAttribute("data-theme-style") ?? "flat");
    });
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- observer subscription that keeps `style` mirrored to the external DOM attribute; the value originates outside React, not from a render-time initializer
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme-style"] });
    return () => observer.disconnect();
  }, []);
  return style;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
const CANVAS_WINDOW_MOTION_MS = 280;
const CANVAS_WINDOW_MOTION_CSS = `
@keyframes canvas-window-restore-from-dock {
  from {
    opacity: 0;
    filter: blur(2px);
    transform: translate(var(--canvas-window-dock-dx), var(--canvas-window-dock-dy)) scale(0.04);
  }
  to {
    opacity: 1;
    filter: blur(0);
    transform: translate(0, 0) scale(1);
  }
}
`;
const CANVAS_WINDOW_MOTION_STYLE_ID = "matrix-canvas-window-motion-styles";

function ensureCanvasWindowMotionStyles() {
  if (typeof document === "undefined" || document.getElementById(CANVAS_WINDOW_MOTION_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = CANVAS_WINDOW_MOTION_STYLE_ID;
  style.textContent = CANVAS_WINDOW_MOTION_CSS;
  document.head.appendChild(style);
}

const win98Bevel = {
  borderTop: "1.5px solid var(--neu-shadow-light)",
  borderLeft: "1.5px solid var(--neu-shadow-light)",
  borderBottom: "1.5px solid var(--neu-shadow-dark)",
  borderRight: "1.5px solid var(--neu-shadow-dark)",
};

interface CanvasWindowProps {
  win: AppWindow;
  /** When true, the window stays mounted but is visually hidden so iframe
      state, terminal sockets, and React state survive minimize -> restore. */
  hidden?: boolean;
  /** Defers expensive app iframe hydration for offscreen Canvas windows. */
  deferAppContent?: boolean;
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- cohesive single-window renderer: the bulk is two theme-specific title-bar JSX trees (mac vs win98) plus drag/resize/fullscreen pointer handlers that all share the same window state and refs. Splitting would require threading every handler and ref through props with no readability or reuse gain.
export function CanvasWindow({ win, hidden = false, deferAppContent = false }: CanvasWindowProps) {
  const chatState = useChatContext();
  const zoom = useCanvasTransform((s) => s.zoom);
  const panX = useCanvasTransform((s) => s.panX);
  const panY = useCanvasTransform((s) => s.panY);
  const closeWindow = useWindowManager((s) => s.closeWindow);
  const minimizeWindow = useWindowManager((s) => s.minimizeWindow);
  const focusWindow = useWindowManager((s) => s.focusWindow);
  const moveWindow = useWindowManager((s) => s.moveWindow);
  const resizeWindow = useWindowManager((s) => s.resizeWindow);
  const focusedWindowId = useWindowManager((s) => s.focusedWindowId);
  const fullscreenWindowId = useWindowManager((s) => s.fullscreenWindowId);
  const iconUrl = useWindowManager((s) => s.apps.find((a) => a.path === win.path)?.iconUrl);
  // react-doctor-disable-next-line react-doctor/no-event-handler -- false positive: `isFocused` is a derived store value, not a DOM event handler. It is read by the reset effect below (already justified for set-state-in-effect / no-adjust-state-on-prop-change), which must remain an effect because it fires on programmatic canvas scroll / focus loss where no event exists to move the logic into.
  const isFocused = focusedWindowId === win.id;
  const isFullscreen = fullscreenWindowId === win.id;
  const showTitles = useCanvasSettings((s) => s.showTitles);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isMobile = useMobileViewport();
  const themeStyle = useThemeStyle();
  const isNeumorphic = themeStyle === "neumorphic";

  const [interacting, setInteracting] = useState(false);
  const [minimizePhase, setMinimizePhase] = useState<"idle" | "minimizing">("idle");
  const isInteractive = zoom >= INTERACTION_THRESHOLD;
  const inverseScale = 1 / zoom;

  // Iframe windows get a "click-to-interact" overlay so wheel events reach
  // the canvas instead of being swallowed by the iframe's browsing context.
  const isIframeWindow = !win.path.startsWith("__");
  const terminalOwnsChrome = win.path.startsWith("__terminal__");
  const isCanvasScrolling = useCanvasTransform((s) => s.isScrolling);
  const [contentFocused, setContentFocused] = useState(false);
  const minimizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [restoreMotion, setRestoreMotion] = useState({ animate: false, previousHidden: hidden });
  if (restoreMotion.previousHidden !== hidden) {
    setRestoreMotion({
      animate: restoreMotion.previousHidden && !hidden,
      previousHidden: hidden,
    });
  }

  const clearWindowMotionTimers = () => {
    if (minimizeTimerRef.current) {
      clearTimeout(minimizeTimerRef.current);
      minimizeTimerRef.current = null;
    }
  };

  useEffect(() => {
    ensureCanvasWindowMotionStyles();
  }, []);

  useEffect(() => () => clearWindowMotionTimers(), []);

  useEffect(() => {
    if (!restoreMotion.animate) return;
    const restoreAnimationTimer = setTimeout(() => {
      setRestoreMotion((current) => current.animate
        ? { ...current, animate: false }
        : current);
    }, CANVAS_WINDOW_MOTION_MS);
    return () => clearTimeout(restoreAnimationTimer);
  }, [restoreMotion.animate]);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-adjust-state-on-prop-change -- `contentFocused` is event-captured (set true on the overlay pointerdown), not derivable from props; this effect resets it to false when the canvas starts scrolling or the window loses focus so the click-to-interact overlay reappears. Computing it in render would discard the user's click.
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

    // Fall back to the transform div's parent if no overflow:hidden ancestor
    // was found (e.g. if clipping uses clip-path instead of overflow).
    const offsetEl = canvasContainer ?? el.parentElement?.parentElement ?? el.parentElement;
    const measure = () => {
      if (offsetEl) {
        const r = offsetEl.getBoundingClientRect();
        setContainerOffset({ x: r.left, y: r.top });
      }
    };
    measure();
    window.addEventListener("resize", measure);

    return () => {
      window.removeEventListener("resize", measure);
      for (const s of saved) {
        // Restore both saved inline values in one write to avoid sequential
        // style mutations; Object.assign on the style object leaves unrelated
        // inline properties untouched.
        Object.assign(s.el.style, { overflow: s.overflow, zIndex: s.zIndex });
      }
    };
  }, [isFullscreen]);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const mouseDragCleanupRef = useRef<(() => void) | null>(null);

  const resizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearMouseDragListeners = () => {
    mouseDragCleanupRef.current?.();
    mouseDragCleanupRef.current = null;
  };

  const startWindowDrag = (clientX: number, clientY: number) => {
    dragRef.current = {
      startX: clientX,
      startY: clientY,
      origX: win.x,
      origY: win.y,
    };
    setInteracting(true);
    focusWindow(win.id);

    // Safety: auto-clear if pointer up never fires
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = setTimeout(() => {
      dragRef.current = null;
      setInteracting(false);
      clearMouseDragListeners();
    }, 5000);
  };

  const moveWindowDrag = (clientX: number, clientY: number) => {
    if (!dragRef.current) return;
    const { startX, startY, origX, origY } = dragRef.current;
    const dx = (clientX - startX) / zoom;
    const dy = (clientY - startY) / zoom;
    moveWindow(win.id, origX + dx, origY + dy);
  };

  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startWindowDrag(e.clientX, e.clientY);
    if (e.target instanceof HTMLElement && e.target.setPointerCapture) {
      e.target.setPointerCapture(e.pointerId);
    }
  };

  const onDragMove = (e: React.PointerEvent) => {
    moveWindowDrag(e.clientX, e.clientY);
  };

  const onDragEnd = () => {
    dragRef.current = null;
    setInteracting(false);
    clearMouseDragListeners();
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
  };

  const onTerminalChromeMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    startWindowDrag(e.clientX, e.clientY);

    const handleMouseMove = (event: MouseEvent) => {
      event.preventDefault();
      moveWindowDrag(event.clientX, event.clientY);
    };
    const handleMouseUp = () => {
      onDragEnd();
    };
    clearMouseDragListeners();
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    mouseDragCleanupRef.current = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  };

  const animateMinimize = () => {
    if (minimizePhase === "minimizing") return;
    if (isFullscreen) {
      minimizeWindow(win.id);
      return;
    }
    clearWindowMotionTimers();
    setMinimizePhase("minimizing");
    minimizeTimerRef.current = setTimeout(() => {
      minimizeTimerRef.current = null;
      minimizeWindow(win.id);
      setMinimizePhase("idle");
    }, CANVAS_WINDOW_MOTION_MS);
  };

  // Double-clicking the title bar zooms the canvas so this app fills the
  // viewport (and centers it) — a quick "zoom into this app" gesture.
  const onTitleDoubleClick = () => {
    const cRect = useCanvasTransform.getState().containerRect;
    focusWindow(win.id);
    useCanvasTransform.getState().zoomToWindow(
      { x: win.x, y: win.y, width: win.width, height: win.height },
      cRect?.width ?? window.innerWidth,
      cRect?.height ?? window.innerHeight,
    );
  };

  const onResizeStart = (e: React.PointerEvent) => {
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
  };

  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const { startX, startY, origW, origH } = resizeRef.current;
    const dw = (e.clientX - startX) / zoom;
    const dh = (e.clientY - startY) / zoom;
    resizeWindow(
      win.id,
      Math.max(MIN_WIDTH, origW + dw),
      Math.max(MIN_HEIGHT, origH + dh),
    );
  };

  const onResizeEnd = () => {
    resizeRef.current = null;
    setInteracting(false);
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
  };

  const titleBarHeight = 36;
  const titleBarGap = 8;

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
      onDoubleClick={onTitleDoubleClick}
    >
      {/* Glass pill container */}
      <div
        className={`relative w-full h-full rounded-2xl flex items-center gap-2 px-3 overflow-hidden transition-all duration-200 backdrop-blur-xl backdrop-saturate-150 ${
          isFocused
            ? "bg-muted/80 border border-border/50 shadow-sm"
            : "bg-muted/40 border border-border/20 opacity-80"
        }`}
      >
        <TrafficLights
          className="mr-2 shrink-0 relative z-10"
          onClose={() => closeWindow(win.id)}
          onMinimize={animateMinimize}
          onFullscreen={() => useWindowManager.getState().toggleFullscreen(win.id)}
        />
        {/* Centered title with icon */}
        <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 relative z-10">
          {iconUrl ? (
            // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png with ?v=etag) that cannot be statically configured for next/image
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
      onDoubleClick={onTitleDoubleClick}
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
            // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png with ?v=etag) that cannot be statically configured for next/image
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
        <div className="flex items-center gap-0.5 shrink-0" onDoubleClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="size-5 flex items-center justify-center text-foreground bg-muted hover:bg-muted/80 active:bg-muted/60"
            style={{
              ...win98Bevel,
              fontSize: "12px",
              lineHeight: 1,
            }}
            onClick={(e) => { e.stopPropagation(); animateMinimize(); }}
            aria-label="Minimize"
          >
            <Minus className="size-2.5" />
          </button>
          <button
            type="button"
            className="size-5 flex items-center justify-center text-foreground bg-muted hover:bg-muted/80 active:bg-muted/60"
            style={{
              ...win98Bevel,
              fontSize: "12px",
              lineHeight: 1,
            }}
            onClick={(e) => { e.stopPropagation(); useWindowManager.getState().toggleFullscreen(win.id); }}
            aria-label="Fullscreen"
          >
            <Maximize2 className="size-2.5" />
          </button>
          <button
            type="button"
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

  // In fullscreen the floating title bar can't sit above the window, so render a
  // static header at the top of the window instead — same traffic lights + title
  // as every other window, double-click to restore. This replaces the old
  // near-invisible exit pill.
  const fullscreenTitleBar = (
    <div
      className="shrink-0 flex items-center gap-2 px-3 h-9 bg-muted/90 border-b border-border/60 select-none backdrop-blur-xl"
      onDoubleClick={() => useWindowManager.getState().toggleFullscreen(win.id)}
    >
      <TrafficLights
        onClose={() => closeWindow(win.id)}
        onMinimize={animateMinimize}
        onFullscreen={() => useWindowManager.getState().toggleFullscreen(win.id)}
      />
      <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0">
        {iconUrl ? (
          // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png with ?v=etag) that cannot be statically configured for next/image
          <img src={iconUrl} alt="" className="size-4 rounded-md object-cover shrink-0" draggable={false} />
        ) : (
          <span className="size-4 rounded-md bg-muted flex items-center justify-center text-[9px] font-semibold text-muted-foreground shrink-0">
            {win.title.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="text-xs font-medium text-foreground/70 truncate">{win.title}</span>
      </div>
      <div className="w-[42px] shrink-0" />
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
        zIndex: SHELL_Z_INDEX.fullscreenWindow,
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
  const shouldAnimateRestore = !hidden && minimizePhase !== "minimizing" && restoreMotion.animate;
  const dockTargetScreenX = -Math.max(0, win.width - 56);
  const dockTargetScreenY = 96;
  const dockTargetCanvasX = (dockTargetScreenX - contLeft) / zoom - panX;
  const dockTargetCanvasY = (dockTargetScreenY - contTop) / zoom - panY;
  const dockDeltaX = dockTargetCanvasX - win.x;
  const dockDeltaY = dockTargetCanvasY - win.y;
  const windowMotionStyle: React.CSSProperties = !isFullscreen
    ? {
        "--canvas-window-dock-dx": `${dockDeltaX}px`,
        "--canvas-window-dock-dy": `${dockDeltaY}px`,
        animation: shouldAnimateRestore
          ? `canvas-window-restore-from-dock ${CANVAS_WINDOW_MOTION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
          : undefined,
        filter: minimizePhase === "minimizing" ? "blur(2px)" : undefined,
        opacity: minimizePhase === "minimizing" ? 0 : undefined,
        pointerEvents: minimizePhase === "minimizing" ? "none" : wrapperStyle.pointerEvents,
        transform: minimizePhase === "minimizing"
          ? "translate(var(--canvas-window-dock-dx), var(--canvas-window-dock-dy)) scale(0.04)"
          : wrapperStyle.transform,
        transformOrigin: minimizePhase === "minimizing" ? "left center" : wrapperStyle.transformOrigin,
        transition: minimizePhase === "minimizing"
          ? `transform ${CANVAS_WINDOW_MOTION_MS}ms cubic-bezier(0.5, 0, 0.7, 0.4), opacity ${CANVAS_WINDOW_MOTION_MS}ms cubic-bezier(0.4, 0, 1, 1), filter ${CANVAS_WINDOW_MOTION_MS}ms ease-out`
          : undefined,
      } as React.CSSProperties
    : {};

  const contentStyle: React.CSSProperties = isFullscreen
    ? { width: vw, height: vh }
    : { width: win.width, height: win.height };
  const nativeAppId = nativeAppIdFromPath(win.path);

  const appContent = (
    <>
      {win.path.startsWith("__terminal__") ? (
        <TerminalApp
          mobile={isMobile}
          launchTargetId={win.id}
          embeddedChrome
          canvasZoom={isFullscreen ? 1 : zoom}
          windowControls={{
            close: () => closeWindow(win.id),
            minimize: animateMinimize,
            toggleFullscreen: () => useWindowManager.getState().toggleFullscreen(win.id),
            dragHandleProps: {
              onPointerDown: onDragStart,
              onPointerMove: onDragMove,
              onPointerUp: onDragEnd,
              onPointerCancel: onDragEnd,
              onMouseDown: onTerminalChromeMouseDown,
              onDoubleClick: onTitleDoubleClick,
            },
          }}
        />
      ) : win.path === "__workspace__" ? (
        <WorkspaceApp />
      ) : win.path === "__file-browser__" ? (
        <FileBrowser windowId={win.id} mobile={isMobile} />
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
              mobile={isMobile}
            />
          )}
        </div>
      ) : win.path === "__activity-monitor__" ? (
        <ActivityMonitorApp />
      ) : deferAppContent ? (
        <div
          className="h-full w-full flex items-center justify-center bg-card"
          aria-label={`${win.title} will load when visible`}
        >
          {iconUrl ? (
            // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png with ?v=etag) that cannot be statically configured for next/image
            <img src={iconUrl} alt="" className="size-16 rounded-2xl object-cover opacity-45" draggable={false} />
          ) : (
            <span className="text-3xl font-semibold text-muted-foreground/20">
              {win.title.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
      ) : nativeAppId ? (
        <NativeAppViewer appId={nativeAppId} windowId={win.id} />
      ) : (
        <AppViewer path={win.path} />
      )}
    </>
  );
  const handleWindowMouseDownCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isFullscreen || !terminalOwnsChrome || event.button !== 0) return;
    focusWindow(win.id);
  };
  const handleWindowMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isFullscreen || terminalOwnsChrome || event.button !== 0) return;
    focusWindow(win.id);
  };

  return (
    // react-doctor-disable-next-line react-doctor/no-static-element-interactions -- presentational positioning wrapper, not a control. The onMouseDown is a pure pointer convenience that raises window focus/z-index; keyboard users focus the window by tabbing into its own interactive children (title-bar buttons and the app content), so no role/onKeyDown is needed. Giving this whole-window container (which wraps an app iframe) a button role would mislabel it for assistive tech.
    <div
      ref={wrapperRef}
      className="absolute"
      data-canvas-window={!isPreview && !isFullscreen || undefined}
      style={{ ...wrapperStyle, ...windowMotionStyle }}
      onMouseDownCapture={handleWindowMouseDownCapture}
      onMouseDown={handleWindowMouseDown}
    >
      {!isFullscreen && titleBar}
      <div
        className={isFullscreen
          ? "bg-background overflow-hidden flex flex-col"
          : isPreview
            ? `rounded-lg bg-card overflow-hidden flex items-center justify-center transition-shadow duration-150 ${
                isFocused ? "shadow-lg ring-1 ring-primary/30" : "shadow-md opacity-80"
              }`
            : terminalOwnsChrome
              ? "rounded-lg bg-card overflow-hidden transition-shadow duration-150 shadow-md"
            : `rounded-lg bg-card overflow-hidden transition-shadow duration-150 ${
                isFocused ? "shadow-xl ring-1 ring-primary/30" : "shadow-md"
              }`
        }
        style={contentStyle}
        onPointerDownCapture={(event) => {
          if (!terminalOwnsChrome || event.button !== 0) return;
          focusWindow(win.id);
        }}
      >
        {isFullscreen && fullscreenTitleBar}
        {isFullscreen ? (
          <div className="relative flex-1 min-h-0 overflow-hidden">{appContent}</div>
        ) : isPreview ? (
          <>
            {iconUrl ? (
              // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png with ?v=etag) that cannot be statically configured for next/image
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
            {!isFullscreen && isIframeWindow && !contentFocused && !interacting && (
              <div
                data-canvas-interaction-overlay
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
