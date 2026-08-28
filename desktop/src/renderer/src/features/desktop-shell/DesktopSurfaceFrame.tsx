import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DESKTOP_Z_INDEX, NATIVE_DESKTOP_LAYOUT } from "../../design/layering";
import type {
  DesktopSurface,
  DesktopSurfaceBounds,
  DesktopTransition,
} from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import { TabErrorBoundary, TabPane } from "../mission-control/TabContent";
import { isSettingsSectionId, SettingsSidebar, type SettingsSectionId } from "../settings/SettingsView";
import { useUi } from "../../stores/ui";
import type { NativeDesktopMode } from "../../stores/native-desktop-mode";
import {
  OSWindow,
  OS_WINDOW_SIDEBAR_WIDTH,
  TopBar,
} from "./OSWindow";
import { SurfaceChromeContext, type SurfaceChromeSpec } from "./SurfaceChrome";

function desktopWindowMotion(tabId: string, bounds: DesktopSurfaceBounds): CSSProperties {
  let hash = 0;
  for (const character of tabId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const direction = Math.abs(hash) % 3;
  const variation = (Math.abs(hash >> 3) % 37) - 18;
  const shell = typeof document !== "undefined"
    ? document.querySelector<HTMLElement>("[data-native-desktop-shell]")
    : null;
  const viewportWidth = shell?.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1280);
  const edge = direction === 0
    ? { x: `${variation}px`, y: `${12 - bounds.y - bounds.height}px` }
    : direction === 1
      ? { x: `${12 - bounds.x - bounds.width}px`, y: `${variation}px` }
      : { x: `${viewportWidth - 12 - bounds.x}px`, y: `${variation}px` };
  return {
    "--desktop-exit-x": edge.x,
    "--desktop-exit-y": edge.y,
  } as CSSProperties;
}

export default function DesktopSurfaceFrame({
  tab,
  surface,
  active,
  tabWorkspaceActive,
  overlayOpen,
  presentation,
  interactionScale = 1,
  workspaceRevision = "",
  desktopTransition = null,
  desktopHiddenSurfaceIds = [],
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
  desktopTransition?: DesktopTransition | null;
  desktopHiddenSurfaceIds?: readonly string[];
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onBoundsChange: (bounds: DesktopSurfaceBounds) => void;
}) {
  const isCanvas = presentation === "canvas";
  const isDesktopWindow = surface.mode === "window";
  const isTabbed = !isCanvas && surface.mode === "tab";
  const isDesktopTransition = !isCanvas
    && desktopTransition?.surfaceIds.includes(surface.tabId) === true;
  const isDesktopHidden = !isCanvas
    && desktopHiddenSurfaceIds?.includes(surface.tabId) === true;
  const isWindow = isDesktopWindow
    || isDesktopHidden
    || isDesktopTransition
    || (isCanvas && surface.mode !== "closed" && surface.mode !== "minimized");
  const visible = isCanvas
    ? isWindow
    : isDesktopHidden || isDesktopTransition || (isDesktopWindow && !tabWorkspaceActive) || (isTabbed && tabWorkspaceActive && active);
  const interactive = visible && active;
  const isNativeEmbed = tab.kind === "home" || tab.kind === "app";
  const sidebarOwnsChrome = tab.kind === "chat" || tab.kind === "terminal" || tab.kind === "terminals" || tab.kind === "settings";
  const requestedSettingsSection = useUi((state) => state.requestedSettingsSection);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("account");
  useEffect(() => {
    if (tab.kind !== "settings" || !requestedSettingsSection) return;
    if (isSettingsSectionId(requestedSettingsSection)) setSettingsSection(requestedSettingsSection);
    useUi.getState().clearRequestedSettingsSection();
  }, [requestedSettingsSection, tab.kind]);
  const paneActive = interactive && !(isNativeEmbed && overlayOpen);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const [surfaceChrome, setSurfaceChrome] = useState<SurfaceChromeSpec | null>(null);
  const surfaceChromeHost = useMemo(() => ({ setChrome: setSurfaceChrome }), []);

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
    ...(isDesktopTransition ? {
      ...desktopWindowMotion(surface.tabId, surface.bounds),
      animation: desktopTransition?.phase === "hiding"
        ? "native-desktop-window-hide 280ms cubic-bezier(0.22, 1, 0.36, 1) both"
        : "native-desktop-window-show 280ms cubic-bezier(0.22, 1, 0.36, 1) both",
      pointerEvents: "none",
    } : isDesktopHidden ? {
      ...desktopWindowMotion(surface.tabId, surface.bounds),
      transform: "translate3d(var(--desktop-exit-x), var(--desktop-exit-y), 0)",
      pointerEvents: "none",
    } : {}),
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
    <SurfaceChromeContext.Provider value={surfaceChromeHost}>
    <OSWindow
      surfaceId={tab.id}
      sidebarWidth={tab.kind === "settings" ? 208 : undefined}
      sidebar={tab.kind === "settings" ? (
        <SettingsSidebar section={settingsSection} onSectionChange={setSettingsSection} />
      ) : undefined}
      safeAreaLayout={sidebarOwnsChrome ? "sidebar" : "pane"}
      topBar={isWindow || surfaceChrome ? (
        <TopBar
          title={surfaceChrome ? surfaceChrome.title : tab.title}
          leftActions={surfaceChrome?.leftActions}
          rightActions={surfaceChrome?.rightActions}
          leftPaneWidth={surfaceChrome?.leftPaneWidth}
          rightPaneWidth={surfaceChrome?.rightPaneWidth}
          showWindowControls={isWindow}
          chromePlacement={sidebarOwnsChrome ? "sidebar" : "full-width"}
          sidebarWidth={sidebarOwnsChrome ? OS_WINDOW_SIDEBAR_WIDTH : undefined}
          onClose={onClose}
          onMinimize={onMinimize}
          onMaximize={onMaximize}
          onDragStart={isWindow ? (event) => startPointerInteraction(event, "move") : undefined}
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
            settingsSection={tab.kind === "settings" ? settingsSection : undefined}
            onSettingsSectionChange={tab.kind === "settings" ? setSettingsSection : undefined}
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
    </SurfaceChromeContext.Provider>
  );
}
