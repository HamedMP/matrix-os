import { GripHorizontal } from "lucide-react";
import { useChatFileNavigation } from "./ChatFileNavigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { CanonicalChatDetailResponse, TerminalSessionSummary } from "@matrix-os/contracts";
import { FileCode2, PanelRightCloseIcon, Plus, SquareTerminal, X } from "@renderer/lib/hugeicons";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
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
import { Button, SideChatPanel, ChatInspectorTabs, ChatInspectorNewTab, type InspectorTool, InspectorToolIcon } from "@matrix-os/ui";
import { useScopedCanonicalChatClient } from "../chat/CanonicalChatClientContext";
import { useSideChatDraft } from "./SideChatDraftContext";

const MAX_TERMINAL_SUMMARY_REFRESH_ATTEMPTS = 4;
const TERMINAL_SUMMARY_REFRESH_DELAY_MS = 1_000;
const MAX_TERMINAL_BINDING_ACTIVITIES = 500;
const MIN_FILE_TREE_HEIGHT = 120;
const MIN_FILE_PREVIEW_HEIGHT = 160;
const FILE_SPLIT_DIVIDER_HEIGHT = 8;

type WorkInspectorTab =
  | { id: "new-tab"; kind: "new"; label: "New tab" }
  | { id: "files"; kind: "files"; label: "Files" }
  | { id: "browser"; kind: "browser"; label: "Browser" }
  | { id: "side-chat"; kind: "side-chat"; label: "Side chat" }
  | { id: string; kind: "terminal"; label: string; sessionId: string };

const NEW_TAB: WorkInspectorTab = { id: "new-tab", kind: "new", label: "New tab" };
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
  const ownerId = useConnection((state) => state.userId);
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
  const summaryRevision = useCodingAgentWorkspace((state) => state.summaryRevision);
  const initialSummaryRevision = useRef(summaryRevision);
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
    const withFiles = restored.length ? restored : [FILES_TAB];
    return initialTerminalTab && !withFiles.some(tab => tab.id === initialTerminalTab.id)
      ? [...withFiles, initialTerminalTab] : withFiles;
  });
  const [selectedId, setSelectedId] = useState(() => initialTerminalTab?.id ??
    (tabs.some(tab => tab.id === savedLayout?.selectedTabId) ? savedLayout!.selectedTabId : FILES_TAB.id));
  const knownSessionIds = sessions.filter(session => session.attachable).map(session => session.id).join("\0");
  const hasFreshSummary = Boolean(summary && summaryRevision > initialSummaryRevision.current);
  useEffect(() => {
    if (!hasFreshSummary) return;
    const known = new Set(knownSessionIds.split("\0").filter(Boolean));
    if (terminalCloseTarget && !known.has(terminalCloseTarget.slice("terminal:".length))) {
      setTerminalCloseTarget(null);
    }
    if (selectedId.startsWith("terminal:") && !known.has(selectedId.slice("terminal:".length))) {
      setSelectedId(FILES_TAB.id);
    }
    setTabs(current => {
      const next = current.filter(tab => tab.kind !== "terminal" || known.has(tab.sessionId));
      return next.length === current.length ? current : next;
    });
  }, [hasFreshSummary, knownSessionIds, selectedId, terminalCloseTarget]);
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
    setTabs(current => current.some(tab => tab.id === "files") ? current : [FILES_TAB, ...current]);
    setSelectedId(FILES_TAB.id);
  }, [requestedFile, scope.chatId, setSelectedFile]);
  const [resolvedChatId, setResolvedChatId] = useState<string | null>(
    detail?.record.chat.id ?? initialTerminal?.chatId ?? null,
  );
  const selected = tabs.find((tab) => tab.id === selectedId) ?? tabs[0] ?? FILES_TAB;
  const terminalBindingKey = detail ? collectTerminalBindingIds(detail).join("\0") : "";
  const unresolvedSessionIds = [...new Set([
    ...terminalBindingKey.split("\0").filter(Boolean),
    ...(!hasFreshSummary ? tabs.flatMap((tab) => tab.kind === "terminal" ? [tab.sessionId] : []) : []),
  ])].filter((sessionId) => !sessions.some((session) => session.id === sessionId && session.attachable)).join("\0");

  useEffect(() => {
    if (!active || !unresolvedSessionIds) return;
    return startTerminalSummaryRefresh(unresolvedSessionIds.split("\0"), refreshSummary);
  }, [active, refreshSummary, unresolvedSessionIds]);

  const openFile = (target: InspectorFileTarget) => {
    setSelectedFile(target);
    setSelectedId(FILES_TAB.id);
  };

  const allowTrash = Boolean(ownerId) && scope.kind === "home" && (!detail || (
    detail.record.chat.ownerScope.type === "personal" && detail.record.chat.ownerScope.ownerId === ownerId
    && detail.record.chat.lifecycle === "active" && !detail.record.chat.collaboration
  ));

  const removeTrashedPreview = (path: string) => {
    if (selectedFile?.kind === "home" && (selectedFile.path === path || selectedFile.path.startsWith(`${path}/`))) {
      useInspectorFileViews.getState().update(viewKey, { selectedFile: null });
    }
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
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const prior = tabs.filter((tab) => tab.id !== id);
    const fallback = prior[Math.min(Math.max(index - 1, 0), prior.length - 1)]?.id ?? NEW_TAB.id;
    setTabs((current) => {
      if (!current.some((tab) => tab.id === id)) return current;
      const next = current.filter((tab) => tab.id !== id);
      return next.length ? next : [NEW_TAB];
    });
    setSelectedId((current) => current === id ? fallback : current);
  };

  const stopTerminalTab = async (id: string) => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.kind !== "terminal") return;
    const session = sessions.find((candidate) => candidate.id === tab.sessionId);
    if (!session) { removeTab(id); return; }
    if (hasFreshSummary && !session.attachable) { removeTab(id); setTerminalCloseTarget(null); return; }
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
    if (!tab) return;
    if (tab.kind !== "terminal") { removeTab(id); return; }
    const session = sessions.find(candidate => candidate.id === tab.sessionId);
    if (!session || (hasFreshSummary && !session.attachable)) { removeTab(id); return; }
    setTerminalCloseTarget(id);
  };

  const splitRef = useRef<HTMLDivElement>(null);
  const [fileTreeHeight, setFileTreeHeight] = useState(() => useInspectorFileViews.getState().views.find((entry) => entry.key === viewKey)?.view.treeHeight ?? 300);
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

  const openPicker = () => {
    setTabs(current => current.some(tab => tab.kind === "new") ? current : [...current, NEW_TAB]);
    setSelectedId(NEW_TAB.id); setMenuOpen(false);
  };
  const chooseTool = (kind: Exclude<InspectorTool, "new">) => {
    setTabs(current => current.filter(tab => tab.kind !== "new"));
    if (kind === "terminal") { void createTerminal(); return; }
    const target = kind === "files" ? FILES_TAB : kind === "browser" ? BROWSER_TAB : SIDE_CHAT_TAB;
    setTabs(current => current.some(tab => tab.id === target.id) ? current : [...current, target]);
    setSelectedId(target.id);
  };
  const handleToolShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || !active || event.repeat) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable=true]")) return;
    const key = event.key.toLowerCase();
    const kind = event.metaKey && event.altKey && key === "s" ? "side-chat"
      : event.metaKey && !event.altKey && key === "p" ? "files"
      : event.ctrlKey && !event.metaKey && key === "`" ? "terminal" : null;
    if (!kind || (kind === "side-chat" && !detail)) return;
    event.preventDefault(); event.stopPropagation(); chooseTool(kind);
  });
  useEffect(() => {
    if (!active) return;
    window.addEventListener("keydown", handleToolShortcut);
    return () => window.removeEventListener("keydown", handleToolShortcut);
  }, [active]);
  return (
    <Tooltip.Provider>
      <aside
        aria-label="Chat inspector"
        className={`flex min-h-0 flex-col overflow-hidden border-l ${className}`}
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <ChatInspectorTabs tabs={tabs.map(tab => ({ ...tab, closing: tab.kind === "terminal" && closingSessionIds.includes(tab.sessionId) }))}
          selectedId={selected.id} onSelect={setSelectedId} onClose={closeTab} onAdd={openPicker}
          addControl={          <DropdownMenu.Root open={menuOpen} onOpenChange={next => {
            if (next && detail && tabs.length === 1 && tabs[0]?.kind === "files" && !selectedFile && attachableSessions.length === 0) openPicker();
            else setMenuOpen(next);
          }}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Add inspector tab"
                onClick={() => { if (detail && tabs.length === 1 && tabs[0]?.kind === "files" && !selectedFile && attachableSessions.length === 0) openPicker(); }}
                className="mb-1 flex size-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
                {selected.kind === "files" ? <InspectorMenuItem label={fileTreeVisible ? "Hide file tree" : "Show file tree"} icon={<FileCode2 size={14}/>} onSelect={() => useInspectorFileViews.getState().update(viewKey, { treeVisible: !fileTreeVisible })}/> : null}
                <InspectorMenuItem label="New tab" icon={<Plus size={14}/>} onSelect={openPicker}/>
                <InspectorMenuItem label="Files" icon={<InspectorToolIcon kind="files"/>} onSelect={() => chooseTool("files")} />
                {detail ? <InspectorMenuItem label="Side chat" icon={<InspectorToolIcon kind="side-chat"/>} onSelect={() => {
                  setTabs(current => current.some(tab => tab.id === SIDE_CHAT_TAB.id) ? current : [...current, SIDE_CHAT_TAB]);
                  setSelectedId(SIDE_CHAT_TAB.id);
                }} /> : null}
                <InspectorMenuItem label="Browser" icon={<InspectorToolIcon kind="browser"/>} onSelect={() => {
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
}
          trailing={onClose ? <button ref={closeButtonRef} type="button" aria-label={closeLabel} title={closeLabel} onClick={onClose} className="mb-1 ml-auto grid size-7 shrink-0 place-items-center"><PanelRightCloseIcon size={14} aria-hidden/></button> : undefined}/>
        {selected.kind === "new" ? <ChatInspectorNewTab browser onChoose={chooseTool} recent={[
          ...(selectedFile ? [{ id: "recent-file", kind: "files" as const, title: selectedFile.label, subtitle: selectedFile.path, onOpen: () => chooseTool("files") }] : []),
          ...attachableSessions.map(session => ({ id: session.id, kind: "terminal" as const, title: session.name, subtitle: "Terminal", onOpen: () => { setTabs(current => current.filter(tab => tab.kind !== "new")); openTerminal(session); } })),
          ...(tabs.some(tab => tab.kind === "side-chat") ? [{ id: "recent-side", kind: "side-chat" as const, title: "Side chat", onOpen: () => chooseTool("side-chat") }] : []),
        ]}/> : null}
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
          hidden={selected.kind === "new"}
          ref={splitRef}
          data-layout={selected.kind === "terminal" ? "terminal" : selectedFile ? "split" : "files-only"}
          className={selected.kind === "new" ? "hidden" : "flex min-h-0 flex-1 flex-col"}
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
                background: "var(--bg-surface)",
              }}
            >
              <InspectorFilesPanel scope={selectedFile?.kind === "home" ? { kind: "home", chatId: scope.chatId } : scope} selectedFile={selectedFile} browserOnly forceList allowTrash={allowTrash} onFileMovedToTrash={removeTrashedPreview} onOpenFile={openFile} />
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
              <span className="absolute inset-x-0 top-[3px] h-px bg-[var(--border-subtle)]" /><GripHorizontal aria-hidden size={12} className="absolute left-1/2 top-[-2px] -translate-x-1/2"/>
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
              {detail && chatClient && sideDraft ? <SideChatPanel chatTitle={detail?.record.chat.title} chatId={detail.record.chat.id} client={chatClient}
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
                    onNewTerminal={() => { void createTerminal(); }}
                    creating={terminalCreateStatus === "creating"}
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
            <Button variant="ghost" size="sm" onClick={() => setTerminalCloseTarget(null)}>Cancel</Button>
            <Button variant="destructive" size="sm"
              onClick={() => { if (terminalCloseTarget) void stopTerminalTab(terminalCloseTarget); }}>Stop terminal</Button>
          </div>
        </div>
      </Dialog>
    </Tooltip.Provider>
  );
}

function TerminalTab({ sessionId, sessions, chatId, active, onNewTerminal, creating }: { sessionId: string; sessions: readonly TerminalSessionSummary[]; chatId: string; active: boolean; onNewTerminal(): void; creating: boolean }) {
  const summary = useCodingAgentWorkspace(state => state.summary);
  const directory = summary ? runtimeTerminalTabs(summary).find(tab => tab.refKey === sessionId)?.cwd : undefined;
  const session = sessions.find((candidate) => candidate.id === sessionId && candidate.attachable);
  if (!session) return <p className="p-4 text-sm" style={{ color: "var(--text-tertiary)" }}>This terminal is unavailable.</p>;
  return <><header className="desktop-chat-design chat-inspector-terminal-header"><span aria-label="Terminal working directory" title={directory || "Home directory"}>{directory || "~"}</span><button type="button" onClick={onNewTerminal} disabled={creating}><Plus size={14} aria-hidden/>New terminal</button></header>
    <TerminalView sessionName={session.id} chatId={chatId} active={active} controlsHost={null} /></>;
}

function InspectorMenuItem({ label, icon, onSelect }: { label: string; icon: ReactNode; onSelect: () => void }) {
  const shortcut = label === "Files" ? "⌘P" : label === "New terminal" ? "⌃`" : label === "Side chat" ? "⌥⌘S" : undefined;
  return (
    <DropdownMenu.Item aria-label={label} className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]" style={{ color: "var(--text-primary)" }} onSelect={onSelect}>
      {icon}
      <span className="flex-1">{label}</span>{shortcut ? <kbd aria-hidden className="text-xs" style={{ color: "var(--text-secondary)", fontFamily: "inherit" }}>{shortcut}</kbd> : null}
    </DropdownMenu.Item>
  );
}
