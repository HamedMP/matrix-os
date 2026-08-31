import { ArrowExpand01, Minus, PanelLeftCloseIcon, PanelLeftOpenIcon, X } from "@renderer/lib/hugeicons";
import {
  createContext,
  type ComponentProps,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { SURFACE_BASE_BACKGROUND } from "../../design/surface";

export const OS_WINDOW_GESTURE_HEIGHT = 48;
export const OS_WINDOW_SIDEBAR_MIN_WIDTH = 200;
export const OS_WINDOW_SIDEBAR_WIDTH = 280;
export const OS_WINDOW_PANE_TRIGGER_CLASS_NAME = "no-drag pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]";
export type OSWindowChromePlacement = "full-width" | "sidebar";
export type OSWindowSafeArea = "pane" | "sidebar";

const OSWindowSafeAreaContext = createContext({
  layout: "pane" as OSWindowSafeArea,
  topInset: 0,
});

interface OSWindowSidebarContextValue {
  available: boolean;
  sidebarId: string;
  sidebarShown: boolean;
  setSidebarShown: (shown: boolean) => void;
}

const OSWindowSidebarContext = createContext<OSWindowSidebarContextValue | null>(null);

/** Shared trigger for sidebars whose visibility is owned by OSWindow. */
export function OSWindowSidebarTrigger({
  label = "Toggle sidebar",
  className,
  onClick,
  onPointerDown,
  style,
  ...props
}: Omit<ComponentProps<"button">, "children" | "aria-label"> & { label?: string }) {
  const sidebar = useContext(OSWindowSidebarContext);
  if (!sidebar?.available) return null;
  const Icon = sidebar.sidebarShown ? PanelLeftCloseIcon : PanelLeftOpenIcon;

  return (
    <button
      type="button"
      aria-label={label}
      aria-controls={sidebar.sidebarId}
      aria-expanded={sidebar.sidebarShown}
      data-os-window-sidebar-trigger=""
      title={label}
      className={`${OS_WINDOW_PANE_TRIGGER_CLASS_NAME} ${className ?? ""}`}
      style={{ color: "var(--text-secondary)", ...style }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      onClick={(event) => {
        sidebar.setSidebarShown(!sidebar.sidebarShown);
        onClick?.(event);
      }}
      {...props}
    >
      <Icon size={15} aria-hidden />
    </button>
  );
}

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
        <X aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/0 transition-colors group-hover/traffic:text-black/60 group-focus-within/traffic:text-black/60" />
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
        <Minus aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/0 transition-colors group-hover/traffic:text-black/60 group-focus-within/traffic:text-black/60" />
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
        <ArrowExpand01 aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/0 transition-colors group-hover/traffic:text-black/60 group-focus-within/traffic:text-black/60" />
      </button>
    </div>
  );
}

export function TopBar({
  title,
  icon,
  leftActions,
  rightActions,
  showWindowControls = true,
  chromePlacement = "full-width",
  sidebarWidth = OS_WINDOW_SIDEBAR_WIDTH,
  leftPaneWidth,
  rightPaneWidth,
  showSidebarTrigger = false,
  sidebarTriggerLabel,
  onClose,
  onMinimize,
  onMaximize,
  onDragStart,
}: {
  title?: string;
  icon?: ReactNode;
  leftActions?: ReactNode;
  rightActions?: ReactNode;
  showWindowControls?: boolean;
  chromePlacement?: OSWindowChromePlacement;
  sidebarWidth?: number;
  leftPaneWidth?: number;
  rightPaneWidth?: number;
  showSidebarTrigger?: boolean;
  sidebarTriggerLabel?: string;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onDragStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const sidebar = useContext(OSWindowSidebarContext);
  const controlsWidth = chromePlacement === "sidebar" ? `${sidebarWidth}px` : "100%";
  const paneAligned = leftPaneWidth !== undefined || rightPaneWidth !== undefined;
  const alignedLeftWidth = Math.max(0, showSidebarTrigger && sidebar?.available && !sidebar.sidebarShown ? 0 : leftPaneWidth ?? 0);
  const alignedRightWidth = Math.max(0, rightPaneWidth ?? 0);
  const hasWindowControls = showWindowControls && onClose && onMinimize && onMaximize;
  const handleDoubleClick = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button,[role='button'],input,a")) return;
    onMaximize?.();
  };

  return (
    <div className="relative shrink-0" style={{ height: OS_WINDOW_GESTURE_HEIGHT }}>
      {onDragStart ? (
        <div
          data-os-window-gesture-layer
          data-testid="desktop-window-drag-handle"
          className="absolute inset-0 z-20"
          onPointerDown={onDragStart}
          onDoubleClick={handleDoubleClick}
        />
      ) : null}
      {paneAligned ? (
        <>
          {hasWindowControls ? (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-40 flex items-center px-4">
              <div data-os-window-traffic-lights className="pointer-events-auto z-30 flex shrink-0 items-center">
                <TrafficLights onClose={onClose} onMinimize={onMinimize} onMaximize={onMaximize} />
              </div>
            </div>
          ) : null}
          {rightActions ? (
            <div className="pointer-events-auto absolute inset-y-0 right-0 z-40 flex items-center px-1">
              {rightActions}
            </div>
          ) : null}
          <div
            data-os-window-chrome-placement={chromePlacement}
            data-testid="os-window-chrome-grid"
            className="pointer-events-none absolute inset-0 z-30 grid"
            style={{
              gridTemplateColumns: `${alignedLeftWidth}px minmax(0, 1fr) ${alignedRightWidth}px`,
            }}
          >
            <div
              className={`flex min-w-0 items-center gap-2 px-3 ${alignedLeftWidth === 0 ? "overflow-visible" : ""}`}
              style={{ borderColor: "var(--border-subtle)" }}
            >
              {alignedLeftWidth > 0 ? <div className="pointer-events-auto ml-auto flex items-center gap-1">{leftActions}</div> : null}
            </div>
            <div className={`flex min-w-0 items-center justify-start gap-1.5 text-[15px] font-medium ${showSidebarTrigger ? "px-1" : "px-3"}`} style={{ color: "var(--text-primary)" }}>
              {alignedLeftWidth === 0 ? (
                <div className="pointer-events-auto flex shrink-0 items-center gap-2">
                  {hasWindowControls ? <div className="w-16 shrink-0" aria-hidden="true" /> : null}
                  {leftActions}
                </div>
              ) : null}
              {title ? (
                <div className={`flex min-w-0 items-center justify-start text-[15px] font-medium ${showSidebarTrigger ? "gap-1" : "gap-1.5"}`}>
                  {showSidebarTrigger ? <OSWindowSidebarTrigger label={sidebarTriggerLabel} /> : null}
                  {icon}
                  <span className="truncate">{title}</span>
                </div>
              ) : null}
            </div>
            <div
              className={alignedRightWidth > 0 ? "min-w-0 border-l" : "min-w-0"}
              style={{ borderColor: "var(--border-subtle)" }}
            />
          </div>
        </>
      ) : (
        <>
          <div
            data-os-window-chrome-placement={chromePlacement}
            className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center px-3"
            style={{ width: controlsWidth }}
          >
            {title ? (
              <>
                <div className="w-28 shrink-0" aria-hidden="true" />
                <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                  {showSidebarTrigger ? <OSWindowSidebarTrigger label={sidebarTriggerLabel} /> : null}
                  {icon}
                  <span className="truncate">{title}</span>
                </div>
                <div className="w-28" aria-hidden="true" />
              </>
            ) : null}
          </div>
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-between px-3">
            <div className="pointer-events-auto flex items-center gap-2">
              {showWindowControls && onClose && onMinimize && onMaximize ? (
                <div data-os-window-traffic-lights className="z-30 flex items-center px-1">
                  <TrafficLights onClose={onClose} onMinimize={onMinimize} onMaximize={onMaximize} />
                </div>
              ) : null}
              {leftActions}
            </div>
            <div className="pointer-events-auto flex items-center gap-1">{rightActions}</div>
          </div>
        </>
      )}
    </div>
  );
}

/** Shared transparent OS-view frame for every Electron app surface. */
export function OSWindow({
  surfaceId,
  sidebarWidth,
  sidebar,
  topBar,
  topBarReservesSafeArea = true,
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
  topBarReservesSafeArea?: boolean;
  safeAreaLayout?: OSWindowSafeArea;
}) {
  const [sidebarShown, setSidebarShown] = useState(true);
  const sidebarAvailable = Boolean(sidebarWidth);
  const sidebarId = `os-window-sidebar-${surfaceId}`;
  const paneSurface = {
    background: SURFACE_BASE_BACKGROUND,
    "--bg-app": SURFACE_BASE_BACKGROUND,
    "--bg-surface": SURFACE_BASE_BACKGROUND,
    "--bg-raised": SURFACE_BASE_BACKGROUND,
    "--bg-sunken": SURFACE_BASE_BACKGROUND,
  } as CSSProperties;

  const safeArea = {
    layout: safeAreaLayout,
    topInset: topBar && topBarReservesSafeArea ? OS_WINDOW_GESTURE_HEIGHT : 0,
  };

  return (
    <OSWindowSidebarContext.Provider value={{
      available: sidebarAvailable,
      sidebarId,
      sidebarShown,
      setSidebarShown,
    }}>
    <OSWindowSafeAreaContext.Provider value={safeArea}>
    <section
      data-os-window
      data-desktop-surface={surfaceId}
      data-sidebar-shown={sidebarAvailable ? sidebarShown : undefined}
      className={`flex flex-col ${className ?? ""}`}
      style={{ ...paneSurface, ...style }}
      {...props}
    >
      <div data-os-window-body className="absolute inset-0 flex min-h-0">
        {sidebarWidth ? (
          <aside
            id={sidebarId}
            data-os-window-sidebar
            data-os-window-sidebar-divider
            hidden={!sidebarShown}
            className={`${sidebarShown ? "flex" : "hidden"} shrink-0 flex-col overflow-hidden`}
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
    </OSWindowSidebarContext.Provider>
  );
}
