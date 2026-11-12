import { useChatFileNavigation } from "./ChatFileNavigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { CanonicalChatDetailResponse, TerminalSessionSummary } from "@matrix-os/contracts";
import { FileCode2, PanelRightCloseIcon, Plus, SquareTerminal, X } from "@renderer/lib/hugeicons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { Project } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import { inspectorFileViewKey, useInspectorFileViews } from "../../stores/files-navigation";
import {
  InspectorFilePreview,
  InspectorFilesPanel,
  type InspectorFileTarget,
} from "../panels/InspectorFilesPanel";
import TerminalView from "../terminal/TerminalView";
import SidebarBrowser from "../browser/SidebarBrowser";
import { resolveWorkFilesScope, type WorkFilesScope } from "./work-files-scope";
import { projectWorkTerminalSessions } from "./work-terminal-scope";
import { parseTerminalRefKey, runtimeTerminalTabs } from "../../lib/terminal-workspaces";
import { Dialog } from "../../design/primitives";
import { chatInspectorLayoutKey, useChatInspectorLayout } from "../../stores/chat-inspector-layout";
import { SideChatPanel } from "@matrix-os/ui";
import { useScopedCanonicalChatClient } from "../chat/CanonicalChatClientContext";
import { useSideChatDraft } from "./SideChatDraftContext";

const MAX_TERMINAL_SUMMARY_REFRESH_ATTEMPTS = 4;
const TERMINAL_SUMMARY_REFRESH_DELAY_MS = 1_000;
const MAX_TERMINAL_BINDING_ACTIVITIES = 500;
const MIN_FILE_TREE_HEIGHT = 120;
const MIN_FILE_PREVIEW_HEIGHT = 160;
const FILE_SPLIT_DIVIDER_HEIGHT = 8;

type WorkInspectorTab =
  | { id: "files"; kind: "files"; label: "Files" }
  | { id: "browser"; kind: "browser"; label: "Browser" }
  | { id: "side-chat"; kind: "side-chat"; label: "Side chat" }
  | { id: string; kind: "terminal"; label: string; sessionId: string };

const FILES_TAB: WorkInspectorTab = { id: "files", kind: "files", label: "Files" };
const BROWSER_TAB: WorkInspectorTab = { id: "browser", kind: "browser", label: "Browser" };
const SIDE_CHAT_TAB: WorkInspectorTab = { id: "side-chat", kind: "side-chat", label: "Side chat" };

function collectTerminalBindingIds(detail: CanonicalChatDetailResponse): string[] {
  const bindingIds = [...(detail.terminalSessionIds ?? [])];
  for (const activity of detail.activities.slice(-MAX_TERMINAL_BINDING_ACTIVITIES)) {
    if (activity.type === "terminal.bound" && !bindingIds.includes(activity.terminalSessionId)) {
      bindingIds.push(activity.terminalSessionId);
    }
  }
  return bindingIds;
}

function startTerminalSummaryRefresh(
  bindingIds: readonly string[],
  refreshSummary: () => Promise<void>,
): () => void {
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  const refreshUntilBindingsResolve = async (): Promise<void> => {
    attempts += 1;
    try {
      await refreshSummary();
    } catch (err: unknown) {
      console.warn("[work] terminal summary refresh failed:", err instanceof Error ? err.message : String(err));
    }
    if (cancelled) return;
    const summary = useCodingAgentWorkspace.getState().summary;
    const liveSessions = summary ? runtimeTerminalTabs(summary).slice(0, 50) : [];
    const unresolved = bindingIds.some((bindingId) => (
      !liveSessions.some((session) => session.refKey === bindingId && session.attachable)
    ));
    if (unresolved && attempts < MAX_TERMINAL_SUMMARY_REFRESH_ATTEMPTS) {
      retryTimer = setTimeout(() => { void refreshUntilBindingsResolve(); }, TERMINAL_SUMMARY_REFRESH_DELAY_MS);
    }
  };
  void refreshUntilBindingsResolve();
  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
  };
}

export function WorkFilesInspector({
  detail,
  scope,
  projects,
  initialTerminal,
  resolveDraftChatId,
  onDraftTerminalCreated,
  active = true,
  className = "w-[520px] shrink-0",
  onClose,
  closeLabel = "Hide inspector",
  closeButtonRef,
}: {
  detail?: CanonicalChatDetailResponse;
  scope?: WorkFilesScope;
  projects: readonly Project[];
  initialTerminal?: { chatId: string; session: TerminalSessionSummary };
  resolveDraftChatId?: () => Promise<string | null>;
  onDraftTerminalCreated?: (chatId: string, session: TerminalSessionSummary) => void;
  active?: boolean;
  className?: string;
  onClose?: () => void;
  closeLabel?: string;
  closeButtonRef?: Ref<HTMLButtonElement>;
}) {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const userId = useConnection((state) => state.userId);
  const resolvedScope = scope ?? (detail
    ? resolveWorkFilesScope(detail, projects)
    : { kind: "unavailable", chatId: "draft" });
  return (
    <WorkInspectorContent
      key={`${inspectorFileViewKey(resolvedScope)}:${runtimeSlot}:${authGeneration}`}
      detail={detail}
      scope={resolvedScope}
      layoutKey={userId && detail?.record.chat.id ? chatInspectorLayoutKey(userId, runtimeSlot || "default", detail.record.chat.id) : null}
      initialTerminal={initialTerminal}
      resolveDraftChatId={resolveDraftChatId}
      onDraftTerminalCreated={onDraftTerminalCreated}
      active={active}
      className={className}
      onClose={onClose}
      closeLabel={closeLabel}
      closeButtonRef={closeButtonRef}
    />
  );
}

function WorkInspectorContent({
  detail,
  scope,
  layoutKey,
  initialTerminal,
  resolveDraftChatId,
  onDraftTerminalCreated,
  active,
  className,
  onClose,
  closeLabel,
  closeButtonRef,
}: {
  detail?: CanonicalChatDetailResponse;
  scope: WorkFilesScope;
  layoutKey: string | null;
  initialTerminal?: { chatId: string; session: TerminalSessionSummary };
  resolveDraftChatId?: () => Promise<string | null>;
  onDraftTerminalCreated?: (chatId: string, session: TerminalSessionSummary) => void;
  active: boolean;
  className: string;
  onClose?: () => void;
  closeLabel: string;
  closeButtonRef?: Ref<HTMLButtonElement>;
}) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const chatClient = useScopedCanonicalChatClient(api, runtimeSlot, authGeneration);
  const sideDraft = useSideChatDraft();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    useUi.getState().acquireRendererOverlay();
    return () => useUi.getState().releaseRendererOverlay();
  }, [menuOpen]);
  const summary = useCodingAgentWorkspace((state) => state.summary);
  const refreshSummary = useCodingAgentWorkspace((state) => state.refresh);
  const [createdSessions, setCreatedSessions] = useState<TerminalSessionSummary[]>(
    initialTerminal ? [initialTerminal.session] : [],
  );
  const [closedSessionIds, setClosedSessionIds] = useState<string[]>([]);
  const [terminalCreateStatus, setTerminalCreateStatus] = useState<"idle" | "creating" | "error">("idle");
  const [terminalCloseError, setTerminalCloseError] = useState(false);
  const [terminalCloseTarget, setTerminalCloseTarget] = useState<string | null>(null);
  const [closingSessionIds, setClosingSessionIds] = useState<string[]>([]);
  const sessionCandidates = [
    ...(detail ? projectWorkTerminalSessions(detail, summary) : []),
    ...createdSessions,
  ];
  const sessions = Array.from(
    new Map(sessionCandidates.map((session) => [session.id, session])).values(),
  ).filter((session) => !closedSessionIds.includes(session.id));
  const attachableSessions = sessions.filter((session) => session.attachable);
  const initialTerminalTab: WorkInspectorTab | null = initialTerminal ? {
    id: `terminal:${initialTerminal.session.id}`,
    kind: "terminal",
    label: initialTerminal.session.name,
    sessionId: initialTerminal.session.id,
  } : null;
  const savedLayout = layoutKey ? useChatInspectorLayout.getState().get(layoutKey) : null;
  const [tabs, setTabs] = useState<WorkInspectorTab[]>(() => {
    const restored = (savedLayout?.openTabIds ?? []).flatMap((id): WorkInspectorTab[] => {
      if (id === "files") return [FILES_TAB];
      if (id === "browser") return [BROWSER_TAB];
      if (id === "side-chat") return [SIDE_CHAT_TAB];
      if (!id.startsWith("terminal:")) return [];
      const sessionId = id.slice("terminal:".length);
      const session = sessions.find(candidate => candidate.id === sessionId);
      return sessionId ? [{ id, kind: "terminal", sessionId, label: session?.name ?? "Terminal" }] : [];
    });
    const withFiles = [FILES_TAB, ...restored.filter(tab => tab.id !== FILES_TAB.id)];
    return initialTerminalTab && !withFiles.some(tab => tab.id === initialTerminalTab.id)
      ? [...withFiles, initialTerminalTab] : withFiles;
  });
  const [selectedId, setSelectedId] = useState(() => initialTerminalTab?.id ??
    (tabs.some(tab => tab.id === savedLayout?.selectedTabId) ? savedLayout!.selectedTabId : FILES_TAB.id));
  const knownSessionIds = sessions.map(session => session.id).join("\0");
  useEffect(() => {
    if (!summary) return;
    const known = new Set(knownSessionIds.split("\0").filter(Boolean));
    setTabs(current => {
      const next = current.filter(tab => tab.kind !== "terminal" || known.has(tab.sessionId));
      if (next.length === current.length) return current;
      if (!next.some(tab => tab.id === selectedId)) setSelectedId(FILES_TAB.id);
      return next;
    });
  }, [summary, knownSessionIds, selectedId]);
  useEffect(() => {
    if (!layoutKey) return;
    useChatInspectorLayout.getState().update(layoutKey, {
      selectedTabId: selectedId,
      openTabIds: tabs.map(tab => tab.id).slice(0, 12),
    });
  }, [layoutKey, selectedId, tabs]);
  const viewKey = inspectorFileViewKey(scope);
  const savedFile = useInspectorFileViews((state) => state.views.find((entry) => entry.key === viewKey)?.view.selectedFile ?? null);
  const selectedFile = useMemo<InspectorFileTarget | null>(() => savedFile && savedFile.kind !== "artifact"
    ? { ...savedFile, label: savedFile.path.split("/").at(-1) ?? savedFile.path } : null, [savedFile]);
  const setSelectedFile = useCallback(({ label: _label, ...target }: InspectorFileTarget) => useInspectorFileViews.getState().update(viewKey, { selectedFile: target }), [viewKey]);
  const fileTreeVisible = useInspectorFileViews((state) => state.views.find((entry) => entry.key === viewKey)?.view.treeVisible ?? true);
  const navigation = useChatFileNavigation();
  const requestedFile = navigation?.request;
  useEffect(() => {
    if (!requestedFile || requestedFile.chatId !== scope.chatId) return;
    setSelectedFile(requestedFile.target);
    setSelectedId(FILES_TAB.id);
  }, [requestedFile, scope.chatId, setSelectedFile]);
  const [resolvedChatId, setResolvedChatId] = useState<string | null>(
    detail?.record.chat.id ?? initialTerminal?.chatId ?? null,
  );
  const selected = tabs.find((tab) => tab.id === selectedId) ?? tabs[0] ?? FILES_TAB;
  const terminalBindingKey = detail ? collectTerminalBindingIds(detail).join("\0") : "";
  const unresolvedBinding = terminalBindingKey.split("\0").filter(Boolean).some((bindingId) => (
    !sessions.some((session) => session.id === bindingId && session.attachable)
  ));

  useEffect(() => {
    if (!active || !unresolvedBinding) return;
    const bindingIds = terminalBindingKey ? terminalBindingKey.split("\0") : [];
    if (bindingIds.length === 0) return;
    return startTerminalSummaryRefresh(bindingIds, refreshSummary);
  }, [active, refreshSummary, terminalBindingKey, unresolvedBinding]);

  const openFile = (target: InspectorFileTarget) => {
    setSelectedFile(target);
    setSelectedId(FILES_TAB.id);
  };

  const openTerminal = (session: TerminalSessionSummary) => {
    const id = `terminal:${session.id}`;
    setTabs((current) => current.some((tab) => tab.id === id)
      ? current
      : [...current, { id, kind: "terminal", label: session.name, sessionId: session.id }]);
    setSelectedId(id);
  };

  const createTerminal = async () => {
    if (!api || terminalCreateStatus === "creating") return;
    setTerminalCreateStatus("creating");
    try {
      const chatId = detail?.record.chat.id ?? resolvedChatId ?? await resolveDraftChatId?.();
      if (!chatId) throw new Error("ChatUnavailable");
      setResolvedChatId(chatId);
      const ensured = await api.post<{ workspace: { id: string } }>("/api/terminal/workspaces/ensure", {
        ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
      });
      const result = await api.post<{ tab: { id: string; name: string; status: TerminalSessionSummary["status"]; createdAt: string; updatedAt: string } }>(
        `/api/terminal/workspaces/${encodeURIComponent(ensured.workspace.id)}/tabs`,
        {
        name: "Chat terminal",
        cwd: "",
        chatId,
        },
      );
      const refKey = `${ensured.workspace.id}:${result.tab.id}`;
      const session: TerminalSessionSummary = {
        id: refKey,
        name: result.tab.name,
        status: result.tab.status,
        attachable: true,
        createdAt: result.tab.createdAt,
        updatedAt: result.tab.updatedAt,
      };
      setCreatedSessions((current) => current.some((candidate) => candidate.id === session.id)
        ? current
        : [...current, session]);
      openTerminal(session);
      if (!detail) onDraftTerminalCreated?.(chatId, session);
      setTerminalCreateStatus("idle");
    } catch (error: unknown) {
      console.warn("[chat] terminal creation failed:", error instanceof Error ? error.name : "UnknownError");
      setTerminalCreateStatus("error");
    }
  };

  const removeTab = (id: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      const safe = next.some((tab) => tab.id === FILES_TAB.id) ? next : [FILES_TAB, ...next];
      if (selectedId === id) setSelectedId(safe[Math.min(Math.max(index - 1, 0), safe.length - 1)]!.id);
      return safe;
    });
  };

  const stopTerminalTab = async (id: string) => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.kind !== "terminal") return;
    const session = sessions.find((candidate) => candidate.id === tab.sessionId);
    if (!session) { removeTab(id); return; }
    if (!api || closingSessionIds.includes(tab.sessionId)) return;
    setTerminalCloseError(false);
    setClosingSessionIds((current) => [...current, tab.sessionId]);
    try {
      const terminalRef = parseTerminalRefKey(session.id);
      if (!terminalRef) throw new Error("Invalid terminal reference");
      await api.delete(`/api/terminal/workspaces/${encodeURIComponent(terminalRef.workspaceId)}/tabs/${encodeURIComponent(terminalRef.tabId)}`);
      setClosedSessionIds((current) => current.includes(tab.sessionId) ? current : [...current, tab.sessionId]);
      setCreatedSessions((current) => current.filter((candidate) => candidate.id !== tab.sessionId));
      removeTab(id);
      void refreshSummary().catch((error: unknown) => {
        console.warn("[work] terminal refresh after close failed:", error instanceof Error ? error.name : "UnknownError");
      });
    } catch (error: unknown) {
      console.warn("[work] terminal close failed:", error instanceof Error ? error.name : "UnknownError");
      setTerminalCloseError(true);
    } finally {
      setClosingSessionIds((current) => current.filter((sessionId) => sessionId !== tab.sessionId));
      setTerminalCloseTarget(null);
    }
  };
  const closeTab = (id: string) => {
    const tab = tabs.find(candidate => candidate.id === id);
    if (!tab || tab.kind !== "terminal") return;
    const session = sessions.find(candidate => candidate.id === tab.sessionId);
    if (!session) { removeTab(id); return; }
    if (session.attachable && (session.status === "starting" || session.status === "running" || session.status === "idle")) {
      setTerminalCloseTarget(id);
      return;
    }
    void stopTerminalTab(id);
  };

  const splitRef = useRef<HTMLDivElement>(null);
  const [fileTreeHeight, setFileTreeHeight] = useState(() => useInspectorFileViews.getState().views.find((entry) => entry.key === viewKey)?.view.treeHeight ?? 240);
  useEffect(() => { useInspectorFileViews.getState().update(viewKey, { treeHeight: fileTreeHeight }); }, [viewKey, fileTreeHeight]);
  const clampFileTreeHeight = (nextHeight: number, splitHeight: number) => Math.max(
    MIN_FILE_TREE_HEIGHT,
    Math.min(
      1200,
      Math.max(MIN_FILE_TREE_HEIGHT, splitHeight - MIN_FILE_PREVIEW_HEIGHT - FILE_SPLIT_DIVIDER_HEIGHT),
      nextHeight,
    ),
  );
  const resizeFileTree = (nextHeight: number) => {
    const measuredHeight = splitRef.current?.getBoundingClientRect().height ?? 0;
    const height = measuredHeight > 0 ? measuredHeight : 640;
    setFileTreeHeight(clampFileTreeHeight(nextHeight, height));
  };
  useEffect(() => {
    const split = splitRef.current;
    if (!split || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (typeof height !== "number" || height <= 0) return;
      setFileTreeHeight((current) => clampFileTreeHeight(current, height));
    });
    observer.observe(split);
    return () => observer.disconnect();
  }, []);
  const startFileTreeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const move = (moveEvent: PointerEvent) => resizeFileTree(moveEvent.clientY - bounds.top);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  return (
    <Tooltip.Provider>
      <aside
        aria-label="Chat inspector"
        className={`flex min-h-0 flex-col overflow-hidden border-l ${className}`}
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
      >
        <div
          className="flex h-11 shrink-0 items-center gap-1 border-b px-2"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <div role="tablist" aria-label="Inspector tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className="flex h-8 min-w-0 shrink-0 items-center rounded-lg"
                style={{ background: selected.id === tab.id ? "var(--bg-selected)" : "transparent" }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected.id === tab.id}
                  aria-controls={`work-inspector-panel-${tab.id}`}
                  className={`flex h-full min-w-0 items-center gap-2 px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${tab.kind === "terminal" ? "rounded-l-lg" : "rounded-lg"}`}
                  style={{ color: selected.id === tab.id ? "var(--text-primary)" : "var(--text-tertiary)" }}
                  onClick={() => setSelectedId(tab.id)}
                >
                  {tab.kind === "terminal" ? <SquareTerminal size={14} aria-hidden /> : <FileCode2 size={14} aria-hidden />}
                  <span className="max-w-32 truncate">{tab.label}</span>
                </button>
                {tab.kind === "terminal" ? (
                  <button
                    type="button"
                    aria-label={`Close ${tab.label} tab`}
                    className="flex size-7 items-center justify-center rounded-r-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    style={{ color: "var(--text-tertiary)" }}
                    disabled={closingSessionIds.includes(tab.sessionId)}
                    onClick={() => closeTab(tab.id)}
                  >
                    <X size={12} aria-hidden />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {selected.kind === "files" ? <button type="button" aria-label={fileTreeVisible ? "Hide file tree" : "Show file tree"} title={fileTreeVisible ? "Hide file tree" : "Show file tree"} aria-pressed={!fileTreeVisible}
            onClick={() => useInspectorFileViews.getState().update(viewKey, { treeVisible: !fileTreeVisible })} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"><FileCode2 size={15} /></button> : null}
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Add inspector tab"
                className="flex size-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                style={{ color: "var(--text-tertiary)" }}
              >
                <Plus size={16} aria-hidden />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-[100] min-w-52 rounded-lg border p-1"
                style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
              >
                <InspectorMenuItem label="Files" icon={<FileCode2 size={14} />} onSelect={() => setSelectedId(FILES_TAB.id)} />
                {detail ? <InspectorMenuItem label="Side chat" icon={<FileCode2 size={14} />} onSelect={() => {
                  setTabs(current => current.some(tab => tab.id === SIDE_CHAT_TAB.id) ? current : [...current, SIDE_CHAT_TAB]);
                  setSelectedId(SIDE_CHAT_TAB.id);
                }} /> : null}
                <InspectorMenuItem label="Browser" icon={<FileCode2 size={14} />} onSelect={() => {
                  setTabs((current) => current.some((tab) => tab.id === BROWSER_TAB.id) ? current : [...current, BROWSER_TAB]);
                  setSelectedId(BROWSER_TAB.id);
                }} />
                {detail || resolveDraftChatId ? (
                  <>
                    <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
                    <InspectorMenuItem label="New terminal" icon={<SquareTerminal size={14} />} onSelect={() => { void createTerminal(); }} />
                  </>
                ) : null}
                {attachableSessions.length > 0 ? <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} /> : null}
                {attachableSessions.map((session) => (
                  <InspectorMenuItem
                    key={session.id}
                    label={`Open terminal ${session.name}`}
                    icon={<SquareTerminal size={14} />}
                    onSelect={() => openTerminal(session)}
                  />
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {onClose ? (
            <button
              ref={closeButtonRef}
              type="button"
              aria-label={closeLabel}
              aria-controls="work-inspector"
              aria-expanded="true"
              title={closeLabel}
              className="flex size-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{ color: "var(--text-tertiary)" }}
              onClick={onClose}
            >
              <PanelRightCloseIcon size={14} aria-hidden />
            </button>
          ) : null}
        </div>
        {terminalCreateStatus === "error" ? (
          <p role="alert" className="shrink-0 border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            The terminal could not be created. Try again.
          </p>
        ) : null}
        {terminalCloseError ? (
          <p role="alert" className="shrink-0 border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            The terminal could not be closed. Try again.
          </p>
        ) : null}
        <div
          ref={splitRef}
          data-layout={selected.kind === "terminal" ? "terminal" : selectedFile ? "split" : "files-only"}
          className="flex min-h-0 flex-1 flex-col"
        >
          {selected.kind === "files" ? (
            <section
              aria-label="Files"
              hidden={!fileTreeVisible}
              className={!fileTreeVisible ? "hidden" : selectedFile
                ? "flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden"
                : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}
              style={{
                ...(selectedFile ? { height: fileTreeHeight } : {}),
                background: "var(--bg-sunken)",
              }}
            >
              <InspectorFilesPanel scope={selectedFile?.kind === "home" ? { kind: "home", chatId: scope.chatId } : scope} selectedFile={selectedFile} browserOnly forceList onOpenFile={openFile} />
            </section>
          ) : null}
          {selected.kind === "files" && selectedFile && fileTreeVisible ? (
            <div
              role="separator"
              aria-label="Resize file list"
              aria-orientation="horizontal"
              aria-valuemin={MIN_FILE_TREE_HEIGHT}
              aria-valuemax={1200}
              aria-valuenow={Math.round(fileTreeHeight)}
              tabIndex={0}
              className="group/file-resize relative z-10 h-2 shrink-0 cursor-row-resize outline-none"
              onPointerDown={startFileTreeResize}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                resizeFileTree(fileTreeHeight + (event.key === "ArrowDown" ? 16 : -16));
              }}
            >
              <span className="absolute inset-x-0 top-[3px] h-px bg-[var(--border-subtle)] group-hover/file-resize:bg-[var(--accent)]" />
            </div>
          ) : null}
          <div
            className={selected.kind === "files" && !selectedFile
              ? "hidden"
              : "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}
            style={{ background: "var(--bg-surface)" }}
          >
            {tabs.some((tab) => tab.kind === "browser") ? <div hidden={selected.kind !== "browser"} className={selected.kind === "browser" ? "flex min-h-0 flex-1 flex-col" : "hidden"} role="tabpanel" aria-label="Browser" id="work-inspector-panel-browser">
              <SidebarBrowser active={active && selected.kind === "browser"} />
            </div> : null}
            {selected.kind === "side-chat" ? <div role="tabpanel" aria-label="Side chat" id="work-inspector-panel-side-chat" className="flex min-h-0 flex-1 flex-col">
              {detail && chatClient && sideDraft ? <SideChatPanel chatId={detail.record.chat.id} client={chatClient}
                onSendToMain={text => sideDraft.request(detail.record.chat.id, text)}/>
                : <p className="p-4 text-sm" style={{ color: "var(--text-tertiary)" }}>Side chat is unavailable.</p>}
            </div> : null}
            {selected.kind === "files" && selectedFile ? (
              <div
                id={`work-inspector-panel-${FILES_TAB.id}`}
                role="tabpanel"
                aria-label="File preview"
                className="flex min-h-0 flex-1 flex-col"
              >
                <InspectorFilePreview target={selectedFile} />
              </div>
            ) : null}
            {tabs.filter((tab) => tab.kind === "terminal").map((tab) => (
              <div
                key={tab.id}
                id={`work-inspector-panel-${tab.id}`}
                role="tabpanel"
                aria-label={tab.label}
                hidden={selected.id !== tab.id}
                className={selected.id === tab.id ? "flex min-h-0 flex-1 flex-col" : "hidden"}
              >
                {tab.kind === "terminal" ? (
                  <TerminalTab
                    sessionId={tab.sessionId}
                    sessions={sessions}
                    chatId={resolvedChatId ?? ""}
                    active={active && selected.id === tab.id}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </aside>
      <Dialog open={terminalCloseTarget !== null} onClose={() => setTerminalCloseTarget(null)} width={400} title="Stop this terminal?">
        <div className="space-y-4 p-4 text-sm" style={{ color: "var(--text-primary)" }}>
          <p>Closing this tab stops its terminal session.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-md px-3 py-1.5" onClick={() => setTerminalCloseTarget(null)}>Cancel</button>
            <button type="button" className="rounded-md px-3 py-1.5" style={{ background: "var(--danger)", color: "var(--bg-surface)" }}
              onClick={() => { if (terminalCloseTarget) void stopTerminalTab(terminalCloseTarget); }}>Stop terminal</button>
          </div>
        </div>
      </Dialog>
    </Tooltip.Provider>
  );
}

function TerminalTab({ sessionId, sessions, chatId, active }: { sessionId: string; sessions: readonly TerminalSessionSummary[]; chatId: string; active: boolean }) {
  const session = sessions.find((candidate) => candidate.id === sessionId && candidate.attachable);
  if (!session) return <p className="p-4 text-sm" style={{ color: "var(--text-tertiary)" }}>This terminal is unavailable.</p>;
  return <TerminalView sessionName={session.id} chatId={chatId} active={active} />;
}

function InspectorMenuItem({ label, icon, onSelect }: { label: string; icon: ReactNode; onSelect: () => void }) {
  return (
    <DropdownMenu.Item aria-label={label} className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]" style={{ color: "var(--text-primary)" }} onSelect={onSelect}>
      {icon}
      {label}
    </DropdownMenu.Item>
  );
}
