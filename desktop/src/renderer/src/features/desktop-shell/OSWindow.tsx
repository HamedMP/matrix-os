import {
  createContext,
  type ComponentProps,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useContext,
} from "react";
import { SURFACE_BASE_BACKGROUND } from "../../design/surface";

export const OS_WINDOW_GESTURE_HEIGHT = 48;
export const OS_WINDOW_SIDEBAR_MIN_WIDTH = 200;
export const OS_WINDOW_SIDEBAR_WIDTH = 280;
export type OSWindowChromePlacement = "full-width" | "sidebar";
export type OSWindowSafeArea = "pane" | "sidebar";

const OSWindowSafeAreaContext = createContext({
  layout: "pane" as OSWindowSafeArea,
  topInset: 0,
});

/** Reserves OS chrome space for the matching area of an OS window. */
export function OSWindowSafeView({
  area = "pane",
  className,
  style,
  children,
  ...props
}: ComponentProps<"div"> & { area?: OSWindowSafeArea }) {
  const { layout, topInset } = useContext(OSWindowSafeAreaContext);
  const paddingTop = layout === area && topInset > 0 ? `${topInset}px` : undefined;

  return (
    <div className={className} style={{ paddingTop, ...style }} {...props}>
      {children}
    </div>
  );
}

export function TrafficLights({
  onClose,
  onMinimize,
  onMaximize,
}: {
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
}) {
  return (
    <div className="group/traffic no-drag flex items-center gap-1.5">
      <button
        type="button"
        aria-label="Close"
        className="no-drag flex size-3 items-center justify-center rounded-full bg-[#ff5f57] transition-colors hover:brightness-90 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <span className="text-[8px] leading-none font-bold text-black/0 transition-colors group-hover/traffic:text-black/60">x</span>
      </button>
      <button
        type="button"
        aria-label="Minimize"
        className="no-drag flex size-3 items-center justify-center rounded-full bg-[#febc2e] transition-colors hover:brightness-90 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onMinimize();
        }}
      >
        <span className="text-[9px] leading-none font-bold text-black/0 transition-colors group-hover/traffic:text-black/60">-</span>
      </button>
      <button
        type="button"
        aria-label="Maximize"
        className="no-drag flex size-3 items-center justify-center rounded-full bg-[#28c840] transition-colors hover:brightness-90 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onMaximize();
        }}
      >
        <span className="text-[8px] leading-none font-bold text-black/0 transition-colors group-hover/traffic:text-black/60">+</span>
      </button>
    </div>
  );
}

export function TopBar({
  title,
  icon,
  chromePlacement = "full-width",
  sidebarWidth = OS_WINDOW_SIDEBAR_WIDTH,
  onClose,
  onMinimize,
  onMaximize,
  onDragStart,
}: {
  title?: string;
  icon?: ReactNode;
  chromePlacement?: OSWindowChromePlacement;
  sidebarWidth?: number;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const controlsWidth = chromePlacement === "sidebar" ? `${sidebarWidth}px` : "100%";
  const handleDoubleClick = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button,[role='button'],input,a")) return;
    onMaximize();
  };

  return (
    <div className="relative shrink-0" style={{ height: OS_WINDOW_GESTURE_HEIGHT }}>
      <div
        data-os-window-gesture-layer
        data-testid="desktop-window-drag-handle"
        className="absolute inset-0 z-20"
        onPointerDown={onDragStart}
        onDoubleClick={handleDoubleClick}
      />
      <div
        data-os-window-chrome-placement={chromePlacement}
        className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center px-3"
        style={{ width: controlsWidth }}
      >
        {title ? (
          <>
            <div className="w-[78px] shrink-0" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-xs font-medium" style={{ color: "var(--text-primary)" }}>
              {icon}
              <span className="truncate">{title}</span>
            </div>
            <div className="w-[78px]" aria-hidden="true" />
          </>
        ) : null}
      </div>
      <div data-os-window-traffic-lights className="absolute inset-y-0 left-0 z-30 flex items-center px-4">
        <TrafficLights onClose={onClose} onMinimize={onMinimize} onMaximize={onMaximize} />
      </div>
    </div>
  );
}

/** Shared transparent OS-view frame for every Electron app surface. */
export function OSWindow({
  surfaceId,
  sidebarWidth,
  sidebar,
  topBar,
  safeAreaLayout = "pane",
  className,
  style,
  children,
  ...props
}: ComponentProps<"section"> & {
  surfaceId: string;
  sidebarWidth?: number;
  sidebar?: ReactNode;
  topBar?: ReactNode;
  safeAreaLayout?: OSWindowSafeArea;
}) {
  const paneSurface = {
    background: SURFACE_BASE_BACKGROUND,
    "--bg-app": SURFACE_BASE_BACKGROUND,
    "--bg-surface": SURFACE_BASE_BACKGROUND,
    "--bg-raised": SURFACE_BASE_BACKGROUND,
    "--bg-sunken": SURFACE_BASE_BACKGROUND,
  } as CSSProperties;

  const safeArea = {
    layout: safeAreaLayout,
    topInset: topBar ? OS_WINDOW_GESTURE_HEIGHT : 0,
  };

  return (
    <OSWindowSafeAreaContext.Provider value={safeArea}>
    <section
      data-os-window
      data-desktop-surface={surfaceId}
      className={`flex flex-col ${className ?? ""}`}
      style={{ ...paneSurface, ...style }}
      {...props}
    >
      <div data-os-window-body className="absolute inset-0 flex min-h-0">
        {sidebarWidth ? (
          <aside
            data-os-window-sidebar
            data-os-window-sidebar-divider
            className="flex shrink-0 flex-col overflow-hidden"
            style={{
              width: sidebarWidth,
              minWidth: OS_WINDOW_SIDEBAR_MIN_WIDTH,
              maxWidth: OS_WINDOW_SIDEBAR_WIDTH,
              borderRight: "1px solid var(--border-default, #F3F2F2)",
            }}
          >
            <OSWindowSafeView area="sidebar" data-os-window-safe-view="sidebar" className="h-full min-h-0 w-full">
              {sidebar}
            </OSWindowSafeView>
          </aside>
        ) : null}
        <main data-os-window-main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {safeAreaLayout === "pane" ? (
            <OSWindowSafeView area="pane" data-os-window-safe-view="pane" className="flex min-h-0 flex-1 flex-col">
              {children}
            </OSWindowSafeView>
          ) : children}
        </main>
      </div>
      {topBar ? (
        <div data-os-window-top-bar-overlay className="absolute inset-x-0 top-0 z-20">
          {topBar}
        </div>
      ) : null}
    </section>
    </OSWindowSafeAreaContext.Provider>
  );
}
