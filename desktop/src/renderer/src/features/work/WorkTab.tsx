import { ArrowLeft, PanelLeftCloseIcon, PanelRightCloseIcon, PanelRightOpen } from "@renderer/lib/hugeicons";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import type { CanonicalChatDetailResponse, CanonicalChatRecord, TerminalSessionSummary } from "@matrix-os/contracts";
import {
  createCanonicalChatClient,
  createCanonicalChatEventSource,
  type CanonicalChatEventSource,
} from "../../lib/canonical-chat-client";
import { useBoard, type Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useProjectView } from "../../stores/project-view";
import type { WorkRoute } from "../../stores/tabs";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import ChatTab from "../chat/ChatTab";
import ProjectChatsView from "../project/ProjectChatsView";
import ProjectsIndex from "../project/ProjectsIndex";
import { WorkRail } from "./WorkRail";
import { WorkFilesInspector } from "./WorkFilesInspector";
import { useSurfaceChromeHost } from "../desktop-shell/SurfaceChrome";
import { OS_WINDOW_PANE_TRIGGER_CLASS_NAME } from "../desktop-shell/OSWindow";
import type { WorkFilesScope } from "./work-files-scope";
import { canonicalChatRequestId } from "../chat/canonical-chat-submission";
import { openWorkProject } from "./work-navigation";
import { useWorkSurfaceRuntime } from "./WorkSurfaceRuntime";

type WorkLayout = "wide" | "medium" | "narrow";
type NarrowWorkPane = "rail" | "chat" | "inspector";

interface WorkResponsiveState {
  layout: WorkLayout;
  navigationOpen: boolean;
  inspectorOpen: boolean;
  narrowPane: NarrowWorkPane;
  narrowPaneRouteKey: string | null;
}

const WIDE_WORK_MIN_WIDTH = 1_280;
const MEDIUM_WORK_MIN_WIDTH = 740;
const NAVIGATION_WIDTH = 240;
const MIN_INSPECTOR_WIDTH = 240;
const MAX_INSPECTOR_WIDTH = 380;
const COLLAPSE_RESIZE_THRESHOLD = 48;

function workLayoutForWidth(width: number): WorkLayout {
  if (width >= WIDE_WORK_MIN_WIDTH) return "wide";
  if (width >= MEDIUM_WORK_MIN_WIDTH) return "medium";
  return "narrow";
}

function effectiveNarrowPane(
  state: WorkResponsiveState,
  routeKey: string,
  canInspect: boolean,
): NarrowWorkPane {
  if (!canInspect || state.narrowPaneRouteKey !== routeKey) return "chat";
  return state.narrowPane;
}

function resizeWork(
  state: WorkResponsiveState,
  nextLayout: WorkLayout,
  routeKey: string,
  canInspect: boolean,
  inspectorFocused: boolean,
  firstMeasurement: boolean,
  preferInspectorOnFirstMeasurement: boolean,
): WorkResponsiveState {
  if (state.layout === nextLayout) return state;
  const pane = effectiveNarrowPane(state, routeKey, canInspect);
  const wasExplicitlyOpen = canInspect && (
    (state.layout === "medium" && state.inspectorOpen)
    || (state.layout === "narrow" && (pane === "inspector" || state.inspectorOpen))
  );
  const preserveInspector = wasExplicitlyOpen
    || (canInspect && firstMeasurement && preferInspectorOnFirstMeasurement)
    || (state.layout === "wide" && canInspect && inspectorFocused);
  return {
    ...state,
    layout: nextLayout,
    ...(nextLayout === "wide" ? {
      inspectorOpen: firstMeasurement ? canInspect : preserveInspector,
    } : {}),
    ...(nextLayout === "medium" ? {
      inspectorOpen: preserveInspector,
      navigationOpen: !preserveInspector,
    } : {}),
    ...(nextLayout === "narrow" ? {
      narrowPane: "chat",
      narrowPaneRouteKey: routeKey,
    } : {}),
  };
}

function ResponsiveWorkInspector({
  detail,
  scope,
  projects,
  active,
  layout,
  onClose,
  onOpen,
  width,
  onResizeStart,
  onResizeKeyboard,
  closeButtonRef,
  openButtonRef,
  regionRef,
  showInlineControls,
  initialTerminal,
  resolveDraftChatId,
  onDraftTerminalCreated,
}: {
  detail?: CanonicalChatDetailResponse;
  scope?: WorkFilesScope;
  projects: Project[];
  active: boolean;
  layout: WorkLayout;
  onClose: () => void;
  onOpen: () => void;
  width: number;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeKeyboard: (delta: number) => void;
  closeButtonRef: Ref<HTMLButtonElement>;
  openButtonRef: Ref<HTMLButtonElement>;
  regionRef: Ref<HTMLDivElement>;
  showInlineControls: boolean;
  initialTerminal?: { chatId: string; session: TerminalSessionSummary };
  resolveDraftChatId?: () => Promise<string | null>;
  onDraftTerminalCreated?: (chatId: string, session: TerminalSessionSummary) => void;
}) {
  if (!active) {
    return (
      <>
        <div hidden><WorkFilesInspector detail={detail} scope={scope} projects={projects} active={false} /></div>
        {showInlineControls && layout !== "narrow" ? (
          <aside
            aria-label="Show Chat inspector rail"
            className="flex w-9 shrink-0 items-start justify-center border-l pt-2"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <PaneButton buttonRef={openButtonRef} label="Show inspector" controls="work-inspector" expanded={false} onClick={onOpen}>
              <PanelRightOpen size={15} aria-hidden />
            </PaneButton>
          </aside>
        ) : null}
      </>
    );
  }
  return (
    <div
      ref={regionRef}
      id="work-inspector"
      aria-hidden={!active}
      hidden={!active}
      className={layout === "narrow"
        ? "absolute inset-0 z-20 flex w-full"
        : "relative flex min-h-0 shrink-0"}
      style={layout === "narrow" ? undefined : { width }}
    >
      {layout !== "narrow" ? <ResizeHandle side="left" label="Resize Chat inspector" value={width} min={MIN_INSPECTOR_WIDTH} max={MAX_INSPECTOR_WIDTH} onPointerDown={onResizeStart} onKeyboardResize={onResizeKeyboard} /> : null}
      <WorkFilesInspector
        detail={detail}
        scope={scope}
        projects={projects}
        initialTerminal={initialTerminal}
        resolveDraftChatId={resolveDraftChatId}
        onDraftTerminalCreated={onDraftTerminalCreated}
        active={active}
        className="h-full w-full"
        onClose={showInlineControls ? onClose : undefined}
        closeLabel={layout === "narrow" ? "Back to chat" : "Hide inspector"}
        closeButtonRef={closeButtonRef}
      />
    </div>
  );
}

export default function WorkTab({
  tabId,
  route,
  projectSlug,
  active,
  initialChatId,
  initialChatView,
  initialChatTitle,
}: {
  tabId?: string;
  route: WorkRoute;
  projectSlug?: string;
  active: boolean;
  initialChatId?: string;
  initialChatView?: "index" | "draft" | "conversation";
  initialChatTitle?: string;
}) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const projects = useBoard((state) => state.projects);
  const workRef = useRef<HTMLDivElement>(null);
  const showToolsRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const showNavigationRef = useRef<HTMLButtonElement>(null);
  const railBackRef = useRef<HTMLButtonElement>(null);
  const inspectorRegionRef = useRef<HTMLDivElement>(null);
  const measuredWidthRef = useRef(false);
  const pendingFocusRef = useRef<RefObject<HTMLButtonElement | null> | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const pendingEventSourceDisposalRef = useRef<{
    source: CanonicalChatEventSource;
    cancelled: boolean;
  } | null>(null);
  const surfaceChromeHost = useSurfaceChromeHost();
  const hostedChrome = surfaceChromeHost !== null;
  const hostedRuntime = useWorkSurfaceRuntime();
  const [responsive, setResponsive] = useState<WorkResponsiveState>({
    layout: "narrow",
    navigationOpen: true,
    inspectorOpen: false,
    narrowPane: "chat",
    narrowPaneRouteKey: null,
  });
  const [inspectorWidth, setInspectorWidth] = useState(MAX_INSPECTOR_WIDTH);
  const [draftTerminalLaunch, setDraftTerminalLaunch] = useState<{
    chatId: string;
    session: TerminalSessionSummary;
  } | null>(null);
  const { layout, navigationOpen, inspectorOpen } = responsive;
  const localClient = useMemo(() => api ? createCanonicalChatClient(api) : null, [api, authGeneration, runtimeSlot]);
  const localEventSource = useMemo<CanonicalChatEventSource | null>(() => {
    if (hostedRuntime || !api || !active) return null;
    return createCanonicalChatEventSource({
      openStream({ cursor, signal }) {
        return api.openStream("/api/chats/events", {
          accept: "text/event-stream",
          signal,
          timeoutMs: 5 * 60 * 1000,
          ...(cursor === undefined ? {} : { headers: { "last-event-id": String(cursor) } }),
        });
      },
    });
  }, [active, api, authGeneration, hostedRuntime, runtimeSlot]);
  const client = hostedRuntime?.client ?? localClient;
  const eventSource = hostedRuntime?.eventSource ?? localEventSource;
  const routeKey = `${active}:${route}:${projectSlug ?? ""}:${initialChatView ?? ""}:${initialChatId ?? ""}`;
  const hasInspector = Boolean(active && (route === "chat" || route === "project"));
  const narrowPane = effectiveNarrowPane(responsive, routeKey, hasInspector);
  const inspectorVisible = active && hasInspector && (
    ((layout === "wide" || layout === "medium") && inspectorOpen)
    || (layout === "narrow" && narrowPane === "inspector")
  );
  const inspectorExclusive = inspectorVisible && layout === "narrow";

  useEffect(() => {
    const pendingDisposal = pendingEventSourceDisposalRef.current;
    if (pendingDisposal?.source === localEventSource) {
      pendingDisposal.cancelled = true;
      pendingEventSourceDisposalRef.current = null;
    }
    if (!localEventSource) return;
    void localEventSource.start();
    return () => {
      const disposal = { source: localEventSource, cancelled: false };
      pendingEventSourceDisposalRef.current = disposal;
      queueMicrotask(() => {
        if (!disposal.cancelled) disposal.source.dispose();
        if (pendingEventSourceDisposalRef.current === disposal) {
          pendingEventSourceDisposalRef.current = null;
        }
      });
    };
  }, [localEventSource]);

  useEffect(() => {
    if (
      draftTerminalLaunch
      && initialChatId === draftTerminalLaunch.chatId
      && initialChatTitle
      && initialChatTitle !== "New chat"
    ) setDraftTerminalLaunch(null);
  }, [draftTerminalLaunch, initialChatId, initialChatTitle]);

  useLayoutEffect(() => {
    if (!active || route !== "project" || !projectSlug) return;
    useProjectView.getState().setView(projectSlug, "chats");
  }, [active, projectSlug, route]);

  useLayoutEffect(() => {
    if (responsive.narrowPaneRouteKey === null || responsive.narrowPaneRouteKey === routeKey) return;
    if (active && layout === "narrow" && responsive.narrowPane === "inspector") {
      pendingFocusRef.current = showNavigationRef;
    }
    setResponsive((current) => ({
      ...current,
      narrowPane: "chat",
      narrowPaneRouteKey: routeKey,
    }));
  }, [active, layout, responsive.narrowPane, responsive.narrowPaneRouteKey, routeKey]);

  useLayoutEffect(() => {
    const node = workRef.current;
    if (!node) return;
    const applyWidth = (width: number) => {
      const firstMeasurement = !measuredWidthRef.current;
      measuredWidthRef.current = true;
      const nextLayout = width > 0 ? workLayoutForWidth(width) : "narrow";
      const inspectorFocused = Boolean(
        inspectorRegionRef.current?.contains(document.activeElement),
      );
      setResponsive((current) => {
        if (nextLayout === "narrow" && current.layout !== "narrow" && inspectorFocused) {
          pendingFocusRef.current = showToolsRef;
        }
        return resizeWork(
          current,
          nextLayout,
          routeKey,
          hasInspector,
          inspectorFocused,
          firstMeasurement,
          initialChatView === "draft",
        );
      });
    };
    applyWidth(node.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") applyWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasInspector, hostedChrome, initialChatId, layout, navigationOpen, routeKey]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    target.current?.focus();
    pendingFocusRef.current = null;
  }, [inspectorOpen, layout, narrowPane]);

  const openInspector = useCallback(() => {
    pendingFocusRef.current = hostedChrome ? showToolsRef : inspectorCloseRef;
    setResponsive((current) => layout === "narrow"
      ? { ...current, inspectorOpen: true, narrowPane: "inspector", narrowPaneRouteKey: routeKey }
      : { ...current, inspectorOpen: true, ...(layout === "medium" ? { navigationOpen: false } : {}) });
  }, [hostedChrome, layout, routeKey]);
  const closeInspector = useCallback(() => {
    pendingFocusRef.current = showToolsRef;
    setResponsive((current) => layout === "narrow"
      ? { ...current, inspectorOpen: false, narrowPane: "chat", narrowPaneRouteKey: routeKey }
      : { ...current, inspectorOpen: false });
  }, [layout, routeKey]);
  const showRail = useCallback(() => {
    pendingFocusRef.current = railBackRef;
    setResponsive((current) => ({
      ...current,
      ...(layout === "narrow" ? { narrowPane: "rail" as const } : { navigationOpen: true, inspectorOpen: layout === "medium" ? false : current.inspectorOpen }),
      narrowPaneRouteKey: routeKey,
    }));
  }, [layout, routeKey]);

  const hideRail = useCallback(() => {
    pendingFocusRef.current = showNavigationRef;
    setResponsive((current) => ({ ...current, navigationOpen: false }));
  }, []);

  const startInspectorResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (layout === "narrow" || event.button !== 0) return;
    event.preventDefault();
    const bounds = workRef.current?.getBoundingClientRect();
    if (!bounds) return;
    resizeCleanupRef.current?.();
    const move = (moveEvent: PointerEvent) => {
      const requested = bounds.right - moveEvent.clientX;
      if (requested <= MIN_INSPECTOR_WIDTH - COLLAPSE_RESIZE_THRESHOLD) {
        closeInspector();
        return;
      }
      setInspectorWidth(Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, requested)));
    };
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    let finished = false;
    const stop = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      captureTarget.removeEventListener("lostpointercapture", stop);
      if (resizeCleanupRef.current === stop) resizeCleanupRef.current = null;
      if (typeof captureTarget.hasPointerCapture === "function"
        && captureTarget.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
    };
    resizeCleanupRef.current = stop;
    captureTarget.setPointerCapture?.(pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    captureTarget.addEventListener("lostpointercapture", stop);
  };
  const resizeInspectorWithKeyboard = (delta: number) => {
    if (inspectorWidth + delta < MIN_INSPECTOR_WIDTH) {
      closeInspector();
      return;
    }
    setInspectorWidth((current) => Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, current + delta)));
  };
  const showChat = useCallback((focusNavigation = false) => {
    if (focusNavigation) pendingFocusRef.current = showNavigationRef;
    setResponsive((current) => ({
      ...current,
      narrowPane: "chat",
      narrowPaneRouteKey: routeKey,
    }));
  }, [routeKey]);
  const openGlobalDraft = useCallback(() => {
    useCodingAgentWorkspace.getState().requestComposerFocus();
    showChat(layout === "narrow");
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "chat",
      chatView: "draft",
      closable: false,
    });
  }, [layout, showChat]);
  const openCreateProject = useCallback(() => useUi.getState().openCreateProject(), []);
  const openProjectDraft = useCallback((project: Project) => {
    showChat(layout === "narrow");
    openWorkProject(project);
  }, [layout, showChat]);
  const selectRailChat = useCallback((record: CanonicalChatRecord, project?: Project) => {
    showChat(layout === "narrow");
    if (project) {
      openWorkProject(project, record.chat.id, record.chat.title);
      return;
    }
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "chat",
      chatId: record.chat.id,
      chatTitle: record.chat.title,
      chatView: "conversation",
      closable: false,
    });
  }, [layout, showChat]);
  const handleRailChatDeleted = useCallback((record: CanonicalChatRecord, project?: Project) => {
    if (record.chat.id !== initialChatId) return;
    if (project) {
      showChat(layout === "narrow");
      openWorkProject(project);
      return;
    }
    openGlobalDraft();
  }, [initialChatId, layout, openGlobalDraft, showChat]);
  const collapseRail = useCallback(() => {
    if (layout === "narrow") showChat(true);
    else hideRail();
  }, [hideRail, layout, showChat]);

  useEffect(() => {
    if (layout !== "medium" || !inspectorVisible) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      pendingFocusRef.current = showToolsRef;
      setResponsive((current) => ({ ...current, inspectorOpen: false }));
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [inspectorVisible, layout]);

  const resolveDraftChatId = useCallback(async (): Promise<string | null> => {
    if (!client) return null;
    const project = route === "project"
      ? projects.find((candidate) => candidate.slug === projectSlug)
      : undefined;
    const projectId = project?.id ?? (route === "project" ? projectSlug : undefined);
    try {
      const record = await client.create({
        clientRequestId: canonicalChatRequestId(),
        title: "New chat",
        ...(projectId ? { projectId } : {}),
      });
      return record.chat.id;
    } catch (error: unknown) {
      console.warn("[work] draft Chat creation for Terminal failed:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }, [client, projectSlug, projects, route]);
  const handleDraftTerminalCreated = useCallback((chatId: string, session: TerminalSessionSummary) => {
    setDraftTerminalLaunch({ chatId, session });
    if (route === "project" && projectSlug) {
      useTabs.getState().openTab({
        kind: "work",
        title: "Chat",
        workRoute: "project",
        projectSlug,
        chatId,
        chatView: "draft",
        closable: false,
      });
      return;
    }
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "chat",
      chatId,
      chatView: "draft",
      closable: false,
    });
  }, [projectSlug, route]);

  const renderInspector = (detail: CanonicalChatDetailResponse) => (
    <ResponsiveWorkInspector
      detail={detail}
      projects={projects}
      active={inspectorVisible}
      layout={layout}
      onClose={closeInspector}
      onOpen={openInspector}
      width={inspectorWidth}
      onResizeStart={startInspectorResize}
      onResizeKeyboard={resizeInspectorWithKeyboard}
      closeButtonRef={inspectorCloseRef}
      openButtonRef={showToolsRef}
      regionRef={inspectorRegionRef}
      showInlineControls={!hostedChrome}
      initialTerminal={draftTerminalLaunch?.chatId === detail.record.chat.id ? draftTerminalLaunch : undefined}
    />
  );
  const draftScope = useMemo<WorkFilesScope>(() => {
    if (route !== "project") return { kind: "home", chatId: "draft:global" };
    const project = projects.find((candidate) => candidate.slug === projectSlug);
    return project
      ? { kind: "project", chatId: `draft:${project.slug}`, projectId: project.slug, label: project.name }
      : { kind: "unavailable", chatId: `draft:${projectSlug ?? "project"}` };
  }, [projectSlug, projects, route]);
  const draftInspector = !initialChatId && hasInspector ? (
    <ResponsiveWorkInspector
      scope={draftScope}
      projects={projects}
      active={inspectorVisible}
      layout={layout}
      onClose={closeInspector}
      onOpen={openInspector}
      width={inspectorWidth}
      onResizeStart={startInspectorResize}
      onResizeKeyboard={resizeInspectorWithKeyboard}
      closeButtonRef={inspectorCloseRef}
      openButtonRef={showToolsRef}
      regionRef={inspectorRegionRef}
      showInlineControls={!hostedChrome}
      resolveDraftChatId={resolveDraftChatId}
      onDraftTerminalCreated={handleDraftTerminalCreated}
    />
  ) : null;
  const canonicalInspector = initialChatId ? renderInspector : undefined;
  const content = route === "chat"
    ? <ChatTab tabId={tabId} active={active} initialChatId={initialChatId} initialView={initialChatView} eventSource={eventSource ?? undefined} externalNavigation renderInspector={canonicalInspector} inspectorExclusive={inspectorExclusive} allowLegacyFallback={false} />
    : route === "projects"
      ? <ProjectsIndex />
      : projectSlug
        ? <ProjectChatsView projectId={projectSlug} active={active} initialChatId={initialChatId} initialView={initialChatView} eventSource={eventSource ?? undefined} externalNavigation renderInspector={canonicalInspector} inspectorExclusive={inspectorExclusive} allowLegacyFallback={false} />
        : null;

  const navigationVisible = layout === "narrow" ? narrowPane === "rail" : navigationOpen;
  const navigationRail = useMemo(() => (
    <WorkRail
      client={client}
      eventSource={eventSource ?? undefined}
      projects={projects}
      active={active}
      activeChatId={initialChatId}
      activeProjectSlug={route === "project" ? projectSlug : undefined}
      className="w-full flex-1"
      onCollapse={collapseRail}
      showCollapseControl={!hostedChrome}
      onNewGlobalChat={openGlobalDraft}
      onCreateProject={openCreateProject}
      onNewProjectChat={openProjectDraft}
      onSelectChat={selectRailChat}
      onChatDeleted={handleRailChatDeleted}
    />
  ), [active, client, collapseRail, eventSource, handleRailChatDeleted, initialChatId, openCreateProject, openGlobalDraft, openProjectDraft, projectSlug, projects, route, selectRailChat]);
  const chromeTitle = initialChatId && initialChatId !== draftTerminalLaunch?.chatId
    ? initialChatTitle ?? "Chat"
    : route === "projects" ? "Chat" : undefined;
  const chromeSpec = useMemo(() => ({
    title: chromeTitle,
    leftPaneWidth: hostedChrome || (layout !== "narrow" && navigationVisible) ? NAVIGATION_WIDTH : 0,
    rightPaneWidth: layout !== "narrow" && inspectorVisible ? inspectorWidth : 0,
    rightActions: hasInspector ? (
      <PaneButton
        buttonRef={showToolsRef}
        label={inspectorVisible ? "Hide inspector" : "Show inspector"}
        controls="work-inspector"
        expanded={inspectorVisible}
        compact
        onClick={inspectorVisible ? closeInspector : openInspector}
      >
        {inspectorVisible
          ? <PanelRightCloseIcon size={15} aria-hidden />
          : <PanelRightOpen size={15} aria-hidden />}
      </PaneButton>
    ) : undefined,
  }), [chromeTitle, closeInspector, hasInspector, hostedChrome, inspectorVisible, inspectorWidth, layout, navigationVisible, openInspector]);

  useLayoutEffect(() => {
    if (!active || !surfaceChromeHost) return;
    surfaceChromeHost.setChrome(chromeSpec);
    return () => surfaceChromeHost.setChrome(null);
  }, [active, chromeSpec, surfaceChromeHost]);

  return (
    <div
      ref={workRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-layout={layout}
      data-pane={layout === "narrow" ? narrowPane : undefined}
    >
      {hostedChrome && hasInspector ? (
        <div
          data-work-main-header
          aria-hidden="true"
          className="h-12 shrink-0"
        />
      ) : null}
      {!hostedChrome && layout === "narrow" && narrowPane === "chat" ? (
        <header
          aria-label="Chat pane controls"
          className="flex h-10 shrink-0 items-center gap-1 border-b px-2"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <PaneButton
            buttonRef={showNavigationRef}
            label="Show Chat navigation"
            controls="work-navigation-pane"
            expanded={false}
            onClick={showRail}
          >
            <PanelLeftCloseIcon size={15} aria-hidden />
          </PaneButton>
          <span className="flex-1 truncate px-2 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Chat
          </span>
          {hasInspector ? (
            <PaneButton
              buttonRef={showToolsRef}
              label="Show inspector"
              controls="work-inspector"
              expanded={false}
              onClick={openInspector}
            >
              <PanelRightOpen size={15} aria-hidden />
            </PaneButton>
          ) : null}
        </header>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {!hostedChrome ? <div
          id="work-navigation-pane"
          hidden={(layout === "narrow" && narrowPane !== "rail") || (layout !== "narrow" && !navigationOpen)}
          className={layout === "narrow"
            ? narrowPane === "rail" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"
            : navigationOpen ? "relative flex min-h-0 shrink-0 flex-col" : "hidden"}
          style={layout !== "narrow" && navigationOpen ? { width: NAVIGATION_WIDTH } : undefined}
        >
          {layout === "narrow" ? (
            <header
              className="flex h-10 shrink-0 items-center gap-2 border-b px-2"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
            >
              <PaneButton buttonRef={railBackRef} label="Back to chat" onClick={() => showChat(true)}>
                <ArrowLeft size={15} aria-hidden />
              </PaneButton>
              <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Chat navigation</span>
            </header>
          ) : null}
          {navigationRail}
        </div> : null}
        {!hostedChrome && layout !== "narrow" && !navigationOpen ? (
          <aside
            aria-label="Show Chat navigation rail"
            className="flex w-9 shrink-0 items-start justify-center border-r pt-2"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <PaneButton buttonRef={showNavigationRef} label="Show Chat navigation" controls="work-navigation-pane" expanded={false} onClick={showRail}>
              <PanelLeftCloseIcon size={15} aria-hidden />
            </PaneButton>
          </aside>
        ) : null}
        <div
          hidden={layout === "narrow" && narrowPane === "rail"}
          className={layout === "narrow" && narrowPane === "rail"
            ? "hidden"
            : "relative flex min-h-0 min-w-0 flex-1 overflow-hidden"}
        >
          {content}
          {draftInspector}
        </div>
      </div>
    </div>
  );
}

function ResizeHandle({ side, label, value, min, max, onPointerDown, onKeyboardResize }: {
  side: "left" | "right";
  label: string;
  value: number;
  min: number;
  max: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onKeyboardResize: (delta: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      className={`group/resize absolute inset-y-0 z-20 w-2 cursor-col-resize outline-none ${side === "left" ? "-left-1" : "-right-1"}`}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (direction === 0) return;
        event.preventDefault();
        onKeyboardResize(side === "left" ? -direction * 16 : direction * 16);
      }}
    >
      <span
        className="absolute inset-y-0 left-[3px] w-px group-hover/resize:bg-[var(--accent)]"
        style={{ background: side === "left" ? "transparent" : "var(--border-subtle)" }}
      />
    </div>
  );
}

function PaneButton({
  buttonRef,
  label,
  controls,
  expanded,
  compact = false,
  onClick,
  children,
}: {
  buttonRef?: Ref<HTMLButtonElement>;
  label: string;
  controls?: string;
  expanded?: boolean;
  compact?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-controls={controls}
      aria-expanded={expanded}
      aria-pressed={expanded}
      title={label}
      className={compact
        ? OS_WINDOW_PANE_TRIGGER_CLASS_NAME
        : "flex size-7 shrink-0 items-center justify-center rounded-md border outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"}
      style={compact ? { color: "var(--text-secondary)" } : { borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}
      onPointerDown={compact ? (event) => event.stopPropagation() : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
