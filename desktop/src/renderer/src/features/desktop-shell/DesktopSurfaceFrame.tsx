import { Maximize2, Minus, X } from "lucide-react";
import { useCallback, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type {
  DesktopSurface,
  DesktopSurfaceBounds,
} from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import { TabErrorBoundary, TabPane } from "../mission-control/TabContent";
import SurfaceIcon from "./SurfaceIcon";

function windowControlClass(color: string): string {
  return `no-drag flex size-3 items-center justify-center rounded-full border-0 ${color} text-transparent transition-colors hover:text-black/55 focus-visible:outline-2 focus-visible:outline-[var(--accent)]`;
}

export default function DesktopSurfaceFrame({
  tab,
  surface,
  active,
  tabWorkspaceActive,
  overlayOpen,
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
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onBoundsChange: (bounds: DesktopSurfaceBounds) => void;
}) {
  const isWindow = surface.mode === "window";
  const isTabbed = surface.mode === "tab";
  const visible = (isWindow && !tabWorkspaceActive) || (isTabbed && tabWorkspaceActive && active);
  const interactive = visible && active;
  const isNativeEmbed = tab.kind === "home" || tab.kind === "app";
  const paneActive = interactive && !(isNativeEmbed && overlayOpen);

  const startPointerInteraction = useCallback((
    event: ReactPointerEvent,
    kind: "move" | "resize",
  ) => {
    if (!isWindow || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button,[role='button'],input,a")) return;
    event.preventDefault();
    onFocus();
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = surface.bounds;
    const move = (pointerEvent: PointerEvent) => {
      const deltaX = pointerEvent.clientX - startX;
      const deltaY = pointerEvent.clientY - startY;
      onBoundsChange(kind === "move"
        ? { ...initial, x: initial.x + deltaX, y: initial.y + deltaY }
        : { ...initial, width: initial.width + deltaX, height: initial.height + deltaY });
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [isWindow, onBoundsChange, onFocus, surface.bounds]);

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
    inset: "38px 0 0",
    zIndex: 2,
    display: visible ? "flex" : "none",
    borderRadius: 0,
    border: 0,
    boxShadow: "none",
  };

  return (
    <section
      role={isWindow && visible ? "dialog" : undefined}
      aria-label={isWindow && visible ? `${tab.title} window` : undefined}
      aria-hidden={!visible}
      data-desktop-surface={tab.id}
      data-surface-mode={surface.mode}
      data-active={active || undefined}
      className="absolute min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--bg-app)] transition-[box-shadow,border-color] duration-150"
      style={frameStyle}
      onPointerDown={isWindow ? onFocus : undefined}
    >
      {isWindow ? (
        <header
          data-testid="desktop-window-drag-handle"
          className="no-drag flex h-[38px] shrink-0 cursor-default items-center border-b px-3"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
          onPointerDown={(event) => startPointerInteraction(event, "move")}
          onDoubleClick={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("button,[role='button'],input,a")) return;
            onMaximize();
          }}
        >
          <div className="no-drag flex w-[78px] items-center gap-2">
            <button type="button" aria-label={`Close ${tab.title}`} className={windowControlClass("bg-[#ed6a5f]")} onClick={onClose}><X size={8} /></button>
            <button type="button" aria-label={`Minimize ${tab.title}`} className={windowControlClass("bg-[#f4bf4f]")} onClick={onMinimize}><Minus size={8} /></button>
            <button type="button" aria-label={`Maximize ${tab.title} into tabs`} className={windowControlClass("bg-[#61c654]")} onClick={onMaximize}><Maximize2 size={7} /></button>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-xs font-medium" style={{ color: "var(--text-primary)" }}>
            <SurfaceIcon tab={tab} size={14} />
            <span className="truncate">{tab.title}</span>
          </div>
          <div className="w-[78px]" aria-hidden="true" />
        </header>
      ) : null}
      <div
        key="surface-content"
        data-testid={`desktop-surface-content-${tab.kind}`}
        className="relative flex min-h-0 flex-1 flex-col"
        inert={!interactive ? true : undefined}
      >
        <TabErrorBoundary tabTitle={tab.title} onClose={onClose}>
          <TabPane tab={tab} active={paneActive} />
        </TabErrorBoundary>
      </div>
      {isWindow ? (
        <div
          role="separator"
          aria-label={`Resize ${tab.title}`}
          className="no-drag absolute bottom-0 right-0 size-4 cursor-nwse-resize"
          onPointerDown={(event) => startPointerInteraction(event, "resize")}
        >
          <span className="absolute bottom-1 right-1 block size-2 border-b border-r" style={{ borderColor: "var(--border-strong)" }} />
        </div>
      ) : null}
    </section>
  );
}
