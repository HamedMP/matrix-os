import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DESKTOP_Z_INDEX, NATIVE_DESKTOP_LAYOUT } from "../../design/layering";
import type {
  DesktopSurface,
  DesktopSurfaceBounds,
} from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import { TabErrorBoundary, TabPane } from "../mission-control/TabContent";
import type { NativeDesktopMode } from "../../stores/native-desktop-mode";
import { OSWindow, OS_WINDOW_SIDEBAR_WIDTH, TopBar } from "./OSWindow";

export default function DesktopSurfaceFrame({
  tab,
  surface,
  active,
  tabWorkspaceActive,
  overlayOpen,
  presentation,
  interactionScale = 1,
  workspaceRevision = "",
  onFocus,
  onClose,
  onMinimize,
  onMaximize,
  onBoundsChange,
}: {
  tab: Tab;
  surface: DesktopSurface;
  active: boolean;
  tabWorkspaceActive: boolean;
  overlayOpen: boolean;
  presentation: NativeDesktopMode;
  interactionScale?: number;
  workspaceRevision?: string;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onBoundsChange: (bounds: DesktopSurfaceBounds) => void;
}) {
  const isCanvas = presentation === "canvas";
  const isDesktopWindow = surface.mode === "window";
  const isTabbed = !isCanvas && surface.mode === "tab";
  const isWindow = isDesktopWindow
    || (isCanvas && surface.mode !== "closed" && surface.mode !== "minimized");
  const visible = isCanvas
    ? isWindow
    : (isDesktopWindow && !tabWorkspaceActive) || (isTabbed && tabWorkspaceActive && active);
  const interactive = visible && active;
  const isNativeEmbed = tab.kind === "home" || tab.kind === "app";
  const terminalOwnsChrome = tab.kind === "terminal" || tab.kind === "terminals";
  const paneActive = interactive && !(isNativeEmbed && overlayOpen);
  const interactionCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => interactionCleanupRef.current?.(), []);

  const startPointerInteraction = useCallback((
    event: ReactPointerEvent,
    kind: "move" | "resize",
  ) => {
    if (!isWindow || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button,[role='button'],input,a")) return;
    event.preventDefault();
    interactionCleanupRef.current?.();
    onFocus();
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = surface.bounds;
    const move = (pointerEvent: PointerEvent) => {
      const scale = Math.max(0.01, interactionScale);
      const deltaX = (pointerEvent.clientX - startX) / scale;
      const deltaY = (pointerEvent.clientY - startY) / scale;
      onBoundsChange(kind === "move"
        ? { ...initial, x: initial.x + deltaX, y: initial.y + deltaY }
        : { ...initial, width: initial.width + deltaX, height: initial.height + deltaY });
    };
    const captureTarget = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      captureTarget.removeEventListener("lostpointercapture", finish);
      if (interactionCleanupRef.current === finish) interactionCleanupRef.current = null;
      if (typeof captureTarget.hasPointerCapture === "function"
        && captureTarget.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
    };
    interactionCleanupRef.current = finish;
    captureTarget.setPointerCapture?.(pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    captureTarget.addEventListener("lostpointercapture", finish);
  }, [interactionScale, isWindow, onBoundsChange, onFocus, surface.bounds]);

  if (surface.mode === "closed") return null;

  const layoutRevision = [
    surface.mode,
    surface.bounds.x,
    surface.bounds.y,
    surface.bounds.width,
    surface.bounds.height,
    presentation,
    workspaceRevision,
  ].join(":");

  const frameStyle: CSSProperties = isWindow ? {
    left: `${surface.bounds.x}px`,
    top: `${surface.bounds.y}px`,
    width: `${surface.bounds.width}px`,
    height: `${surface.bounds.height}px`,
    zIndex: surface.zIndex,
    display: visible ? "flex" : "none",
    borderRadius: "var(--radius-lg)",
    border: `1px solid ${active ? "var(--border-default)" : "var(--border-subtle)"}`,
    boxShadow: active ? "var(--shadow-3)" : "var(--shadow-2)",
  } : {
    inset: 0,
    zIndex: DESKTOP_Z_INDEX.nativeDesktopTabSurface,
    display: visible ? "flex" : "none",
    borderRadius: 0,
    border: 0,
    boxShadow: "none",
  };

  return (
    <OSWindow
      surfaceId={tab.id}
      sidebarWidth={terminalOwnsChrome ? OS_WINDOW_SIDEBAR_WIDTH : undefined}
      topBar={isWindow ? (
        <TopBar
          chromePlacement={terminalOwnsChrome ? "sidebar" : "full-width"}
          sidebarWidth={terminalOwnsChrome ? OS_WINDOW_SIDEBAR_WIDTH : undefined}
          onClose={onClose}
          onMinimize={onMinimize}
          onMaximize={onMaximize}
          onDragStart={(event) => startPointerInteraction(event, "move")}
        />
      ) : null}
      role={isWindow && visible ? "dialog" : undefined}
      aria-label={isWindow && visible ? `${tab.title} window` : undefined}
      aria-hidden={!visible}
      onContextMenu={(event) => event.stopPropagation()}
      data-surface-mode={surface.mode}
      data-active={active || undefined}
      className="pointer-events-auto absolute min-h-0 min-w-0 flex-col overflow-hidden transition-[box-shadow,border-color] duration-150"
      style={frameStyle}
      onPointerDown={isWindow ? onFocus : undefined}
    >
      <div
        key="surface-content"
        data-testid={`desktop-surface-content-${tab.kind}`}
        className="relative flex min-h-0 flex-1 flex-col"
        inert={!interactive ? true : undefined}
        style={isNativeEmbed && isWindow ? {
          paddingRight: `${NATIVE_DESKTOP_LAYOUT.resizeHandleSize}px`,
          paddingBottom: `${NATIVE_DESKTOP_LAYOUT.resizeHandleSize}px`,
        } : undefined}
      >
        <TabErrorBoundary tabTitle={tab.title} onClose={onClose}>
          <TabPane
            tab={tab}
            active={paneActive}
            visible={visible}
            layoutRevision={layoutRevision}
            visualScale={presentation === "canvas" ? interactionScale : 1}
          />
        </TabErrorBoundary>
      </div>
      {isWindow ? (
        <div
          role="separator"
          aria-label={`Resize ${tab.title}`}
          className="no-drag absolute bottom-0 right-0 cursor-nwse-resize"
          style={{
            width: `${NATIVE_DESKTOP_LAYOUT.resizeHandleSize}px`,
            height: `${NATIVE_DESKTOP_LAYOUT.resizeHandleSize}px`,
          }}
          onPointerDown={(event) => startPointerInteraction(event, "resize")}
        >
          <span className="absolute bottom-1 right-1 block size-2 border-b border-r" style={{ borderColor: "var(--border-strong)" }} />
        </div>
      ) : null}
    </OSWindow>
  );
}
