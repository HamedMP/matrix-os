import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { CanonicalChatDetailResponse, TerminalSessionSummary } from "@matrix-os/contracts";
import { FileCode2, PanelRightCloseIcon, Plus, SquareTerminal, X } from "@renderer/lib/hugeicons";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { Project } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import {
  InspectorFilePreview,
  InspectorFilesPanel,
  type InspectorFileTarget,
} from "../panels/InspectorFilesPanel";
import TerminalView from "../terminal/TerminalView";
import { resolveWorkFilesScope, type WorkFilesScope } from "./work-files-scope";
import { projectWorkTerminalSessions } from "./work-terminal-scope";
import { parseTerminalRefKey, runtimeTerminalTabs } from "../../lib/terminal-workspaces";

const MAX_TERMINAL_SUMMARY_REFRESH_ATTEMPTS = 4;
const TERMINAL_SUMMARY_REFRESH_DELAY_MS = 1_000;
const MAX_TERMINAL_BINDING_ACTIVITIES = 500;
const MIN_FILE_LIST_WIDTH = 220;
const MIN_FILE_PREVIEW_WIDTH = 240;
const FILE_LIST_DIVIDER_WIDTH = 8;

type WorkInspectorTab =
  | { id: "files"; kind: "files"; label: "Files" }
  | { id: string; kind: "terminal"; label: string; sessionId: string };

const FILES_TAB: WorkInspectorTab = { id: "files", kind: "files", label: "Files" };

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
  const resolvedScope = scope ?? (detail
    ? resolveWorkFilesScope(detail, projects)
    : { kind: "unavailable", chatId: "draft" });
  return (
    <WorkInspectorContent
      key={`${detail?.record.chat.id ?? resolvedScope.chatId}:${runtimeSlot}:${authGeneration}`}
      detail={detail}
      scope={resolvedScope}
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
  const summary = useCodingAgentWorkspace((state) => state.summary);
  const refreshSummary = useCodingAgentWorkspace((state) => state.refresh);
  const [createdSessions, setCreatedSessions] = useState<TerminalSessionSummary[]>(
    initialTerminal ? [initialTerminal.session] : [],
  );
  const [closedSessionIds, setClosedSessionIds] = useState<string[]>([]);
  const [terminalCreateStatus, setTerminalCreateStatus] = useState<"idle" | "creating" | "error">("idle");
  const [terminalCloseError, setTerminalCloseError] = useState(false);
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
  const [tabs, setTabs] = useState<WorkInspectorTab[]>(
    initialTerminalTab ? [FILES_TAB, initialTerminalTab] : [FILES_TAB],
  );
  const [selectedId, setSelectedId] = useState(initialTerminalTab?.id ?? FILES_TAB.id);
  const [selectedFile, setSelectedFile] = useState<InspectorFileTarget | null>(null);
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

  const closeTab = async (id: string) => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.kind !== "terminal") return;
    const session = sessions.find((candidate) => candidate.id === tab.sessionId);
    if (!api || !session || closingSessionIds.includes(tab.sessionId)) return;
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
    }
  };

  const splitRef = useRef<HTMLDivElement>(null);
  const [fileListWidth, setFileListWidth] = useState(300);
  const clampFileListWidth = (nextWidth: number, splitWidth: number) => Math.max(
    MIN_FILE_LIST_WIDTH,
    Math.min(
      Math.max(MIN_FILE_LIST_WIDTH, splitWidth - MIN_FILE_PREVIEW_WIDTH - FILE_LIST_DIVIDER_WIDTH),
      nextWidth,
    ),
  );
  const resizeFileList = (nextWidth: number) => {
    const measuredWidth = splitRef.current?.getBoundingClientRect().width ?? 0;
    const width = measuredWidth > 0 ? measuredWidth : 760;
    setFileListWidth(clampFileListWidth(nextWidth, width));
  };
  useEffect(() => {
    const split = splitRef.current;
    if (!split || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width !== "number" || width <= 0) return;
      setFileListWidth((current) => clampFileListWidth(current, width));
    });
    observer.observe(split);
    return () => observer.disconnect();
  }, []);
  const startFileListResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const move = (moveEvent: PointerEvent) => resizeFileList(moveEvent.clientX - bounds.left);
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
                    onClick={() => { void closeTab(tab.id); }}
                  >
                    <X size={12} aria-hidden />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <DropdownMenu.Root>
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
          className="flex min-h-0 flex-1"
        >
          {selected.kind === "files" ? (
            <section
              aria-label="Files"
              className={selectedFile
                ? "flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden"
                : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}
              style={{
                ...(selectedFile ? { width: fileListWidth } : {}),
                background: "var(--bg-sunken)",
              }}
            >
              <InspectorFilesPanel scope={scope} browserOnly forceList onOpenFile={openFile} />
            </section>
          ) : null}
          {selected.kind === "files" && selectedFile ? (
            <div
              role="separator"
              aria-label="Resize file list"
              aria-orientation="vertical"
              aria-valuemin={MIN_FILE_LIST_WIDTH}
              aria-valuemax={820}
              aria-valuenow={Math.round(fileListWidth)}
              tabIndex={0}
              className="group/file-resize relative z-10 w-2 shrink-0 cursor-col-resize outline-none"
              onPointerDown={startFileListResize}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                resizeFileList(fileListWidth + (event.key === "ArrowRight" ? 16 : -16));
              }}
            >
              <span className="absolute inset-y-0 left-[3px] w-px bg-[var(--border-subtle)] group-hover/file-resize:bg-[var(--accent)]" />
            </div>
          ) : null}
          <div
            className={selected.kind === "files" && !selectedFile
              ? "hidden"
              : "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}
            style={{ background: "var(--bg-surface)" }}
          >
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
