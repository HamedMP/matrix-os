import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  Clipboard,
  Edit3,
  ExternalLink,
  GripVertical,
  Layers,
  MoreHorizontal,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, EmptyState, IconButton } from "../../design/primitives";
import RetainedPane from "../../design/RetainedPane";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { categoryMessage } from "../../../../shared/app-error";
import {
  isValidShellSessionName,
  type ShellSessionPlacement,
  type ShellSessionSummary,
  useShellSessions,
} from "../../stores/shell-sessions";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useTerminalAppearance } from "../../stores/terminal-appearance";
import {
  reconcileShellSessionSnapshot,
  syncShellSessions,
} from "../../lib/shell-session-sync";
import TerminalView from "./TerminalView";
import { SURFACE_BASE_BACKGROUND } from "../../design/surface";
import { TerminalSessionSidebar } from "./TerminalSessionSidebar";
import { relativeSessionActivity } from "./terminal-session-activity";

const RENAME_HELP = "Use lowercase letters, numbers, and hyphens. Start and end with a letter or number.";
const SESSION_START_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const MAX_PRESERVED_TERMINALS = 8;

function attachCommand(shell: ShellSessionSummary): string {
  return shell.attachCommand ?? `matrix shell connect ${shell.name}`;
}

function shellStatusLabel(shell: ShellSessionSummary): string {
  if (shell.status === "exited" || shell.visualStatus === "finished") return "Closed";
  if (shell.status === "degraded" || shell.visualStatus === "waiting") return "Waiting";
  return "Active";
}

function shellTitle(shell: ShellSessionSummary): string {
  return shell.subtitle?.trim() || shell.lastAction?.trim() || shell.name;
}

function mostRecentShell(sessions: ShellSessionSummary[]): ShellSessionSummary | null {
  return sessions.reduce<ShellSessionSummary | null>((latest, session) => {
    if (!latest) return session;
    const latestActivity = Date.parse(latest.updatedAt ?? latest.createdAt ?? "");
    const sessionActivity = Date.parse(session.updatedAt ?? session.createdAt ?? "");
    return Number.isFinite(sessionActivity) && (!Number.isFinite(latestActivity) || sessionActivity > latestActivity)
      ? session
      : latest;
  }, null);
}

function sessionStart(createdAt: string | undefined): string {
  if (!createdAt) return "an unknown time";
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return "an unknown time";
  return SESSION_START_FORMATTER.format(timestamp);
}

function placementFor(shell: ShellSessionSummary, openShellNames: Set<string>): ShellSessionPlacement {
  return shell.placement ?? (openShellNames.has(shell.name) ? "active" : "background");
}

function normalizeBusyNames(names: string[]): string[] {
  return names.filter((name, index) => name.length > 0 && names.indexOf(name) === index);
}

function TerminalAppTabs({
  openedSessionNames,
  selectedName,
  onSelectOverview,
  onSelectSession,
  onCloseSession,
}: {
  openedSessionNames: string[];
  selectedName: string | null;
  onSelectOverview: () => void;
  onSelectSession: (name: string) => void;
  onCloseSession: (name: string) => void;
}) {
  if (openedSessionNames.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="Terminal app tabs"
      className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b px-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
    >
      <button
        type="button"
        role="tab"
        aria-label="Terminal sessions"
        aria-selected={selectedName === null}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-t-md border px-2.5 text-xs"
        style={{
          borderColor: selectedName === null ? "var(--border-subtle)" : "transparent",
          borderBottomColor: selectedName === null ? "var(--bg-surface)" : "transparent",
          background: selectedName === null ? "var(--bg-surface)" : "transparent",
          color: selectedName === null ? "var(--text-primary)" : "var(--text-secondary)",
        }}
        onClick={onSelectOverview}
      >
        <SquareTerminal size={12} aria-hidden="true" /> Sessions
      </button>
      {openedSessionNames.map((name) => {
        const selected = selectedName === name;
        return (
          <div
            key={name}
            className="group flex h-7 min-w-[116px] max-w-[190px] items-center rounded-t-md border pl-2.5 pr-1"
            style={{
              borderColor: selected ? "var(--border-subtle)" : "transparent",
              borderBottomColor: selected ? "var(--bg-surface)" : "transparent",
              background: selected ? "var(--bg-surface)" : "transparent",
              color: selected ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <button
              type="button"
              role="tab"
              aria-label={name}
              aria-selected={selected}
              className="min-w-0 flex-1 truncate text-left font-mono text-[11px]"
              onClick={() => onSelectSession(name)}
            >
              {name}
            </button>
            <button
              type="button"
              aria-label={`Close ${name} terminal tab`}
              className="flex size-5 shrink-0 items-center justify-center rounded opacity-60 hover:bg-[var(--bg-hover)] hover:opacity-100"
              onClick={() => onCloseSession(name)}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- TerminalsTab is the cohesive shell-session workspace: network load/create, selection, rename, delete confirmation, search, and drag refs are independent UI concerns. A reducer would couple unrelated state transitions without reducing render risk; extracting subcomponents below keeps the row/empty states isolated.
export default function TerminalsTab({
  active = true,
  visible = active,
}: {
  active?: boolean;
  visible?: boolean;
}) {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const shells = useShellSessions((s) => s.sessions);
  const loading = useShellSessions((s) => s.loading);
  const creating = useShellSessions((s) => s.creating);
  const error = useShellSessions((s) => s.error);
  const loadSequence = useShellSessions((s) => s.loadSequence);
  const authoritativeRevision = useShellSessions((s) => s.authoritativeRevision);
  const create = useShellSessions((s) => s.create);
  const deleteSession = useShellSessions((s) => s.deleteSession);
  const rename = useShellSessions((s) => s.rename);
  const reorder = useShellSessions((s) => s.reorder);
  const patchUiState = useShellSessions((s) => s.patchUiState);
  const tabs = useTabs((s) => s.tabs);
  const recordRecentTerminal = useTabs((s) => s.recordRecentTerminal);
  const reconcileRecentTerminals = useTabs((s) => s.reconcileRecentTerminals);
  const terminalSessionRequest = useTabs((s) => s.terminalSessionRequest);
  const terminalAppearanceMode = useTerminalAppearance((s) => s.mode);
  const consumeTerminalSessionRequest = useTabs((s) => s.consumeTerminalSessionRequest);
  const terminalsTabId = useTabs((s) => s.tabs.find((tab) => tab.kind === "terminals")?.id);
  const renameTab = useTabs((s) => s.renameTab);
  const renameTerminalSession = useTabs((s) => s.renameTerminalSession);
  const [selectedName, setSelectedName] = useState<string | null>(() => mostRecentShell(shells)?.name ?? null);
  const [liveSessionName, setLiveSessionName] = useState<string | null>(null);
  const [openedSessionNames, setOpenedSessionNames] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busyNames, setBusyNames] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ShellSessionSummary | null>(null);
  const draggingNameRef = useRef<string | null>(null);
  const draggingPlacementRef = useRef<ShellSessionPlacement | null>(null);

  useEffect(() => {
    if (loading || error || authoritativeRevision === 0) return;
    const liveNames = new Set(shells.map((shell) => shell.name));
    reconcileRecentTerminals([...liveNames]);
    setOpenedSessionNames((current) => {
      const retained = current.filter((name) => liveNames.has(name));
      return retained.length === current.length ? current : retained;
    });
    setLiveSessionName((current) => current && liveNames.has(current) ? current : null);
    setSelectedName((current) => current && liveNames.has(current) ? current : null);
  }, [authoritativeRevision, error, loading, reconcileRecentTerminals, shells]);

  const openShellNames = useMemo(
    () => new Set([
      ...tabs.flatMap((tab) => (tab.kind === "terminal" && tab.sessionName ? [tab.sessionName] : [])),
      ...(liveSessionName ? [liveSessionName] : []),
    ]),
    [liveSessionName, tabs],
  );

  const latestShell = useMemo(() => mostRecentShell(shells), [shells]);
  const selected = selectedName && shells.some((shell) => shell.name === selectedName)
    ? selectedName
    : latestShell?.name ?? null;
  const visibleSessionNames = useMemo(() => {
    if (!selected || openedSessionNames.includes(selected)) return openedSessionNames;
    return [...openedSessionNames, selected].slice(-MAX_PRESERVED_TERMINALS);
  }, [openedSessionNames, selected]);

  useEffect(() => {
    if (!terminalsTabId) return;
    renameTab(terminalsTabId, "Terminal");
  }, [renameTab, terminalsTabId]);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const renamingNameRef = useRef<string | null>(null);
  renamingNameRef.current = renamingName;
  const busyNamesRef = useRef<string[]>([]);
  busyNamesRef.current = busyNames;

  const isShellBusy = (name: string) => busyNames.includes(name);

  const markShellsBusy = (names: string[]): boolean => {
    const namesToMark = normalizeBusyNames(names);
    if (namesToMark.some((name) => busyNamesRef.current.includes(name))) return false;
    setBusyNames((current) => [
      ...current,
      ...namesToMark.filter((name) => !current.includes(name)),
    ]);
    return true;
  };

  const markShellBusy = (name: string): boolean => markShellsBusy([name]);

  const clearShellsBusy = (names: string[]) => {
    const namesToClear = normalizeBusyNames(names);
    setBusyNames((current) => current.filter((busyName) => !namesToClear.includes(busyName)));
  };

  const clearShellBusy = (name: string) => clearShellsBusy([name]);

  const createShell = async () => {
    if (!api || creating) return;
    setActionError(null);
    const created = await create(api);
    if (!created) {
      setActionError("Could not create shell");
      return;
    }
    recordRecentTerminal(created.name, created.name);
    showShellDetail(created);
  };

  const showShellDetail = useCallback((shell: ShellSessionSummary) => {
    setOpenedSessionNames((current) => [
      ...current.filter((name) => name !== shell.name),
      shell.name,
    ].slice(-MAX_PRESERVED_TERMINALS));
    setLiveSessionName(shell.name);
    setSelectedName(shell.name);
    if (shell.latestSeq !== undefined && shell.latestSeq !== null && shell.lastSeenSeq !== shell.latestSeq && api) {
      void patchUiState(api, shell.name, { lastSeenSeq: shell.latestSeq });
    }
  }, [api, patchUiState]);

  useEffect(() => {
    if (!latestShell || (selectedName && liveSessionName)) return;
    const selectedShell = selectedName
      ? shells.find((shell) => shell.name === selectedName)
      : latestShell;
    if (selectedShell) showShellDetail(selectedShell);
  }, [latestShell, liveSessionName, selectedName, shells, showShellDetail]);

  useEffect(() => {
    if (!terminalSessionRequest) return;
    if (terminalSessionRequest.sessionName === null) {
      setSelectedName(null);
      setLiveSessionName(null);
      consumeTerminalSessionRequest(terminalSessionRequest.requestId);
      return;
    }
    const requestedShell = shells.find((shell) => shell.name === terminalSessionRequest.sessionName);
    if (!requestedShell) {
      if (!loading && !creating && !error && loadSequence > 0) {
        consumeTerminalSessionRequest(terminalSessionRequest.requestId);
      }
      return;
    }
    showShellDetail(requestedShell);
    consumeTerminalSessionRequest(terminalSessionRequest.requestId);
  }, [
    consumeTerminalSessionRequest,
    creating,
    error,
    loading,
    loadSequence,
    shells,
    showShellDetail,
    terminalSessionRequest,
  ]);

  const openShellInTab = (shell: ShellSessionSummary) => showShellDetail(shell);

  const closeShellTab = (name: string) => {
    const remaining = openedSessionNames.filter((openedName) => openedName !== name);
    setOpenedSessionNames(remaining);
    if (selectedRef.current !== name) return;
    const nextName = remaining.at(-1) ?? null;
    setSelectedName(nextName);
    setLiveSessionName(nextName);
  };

  const moveShell = async (shell: ShellSessionSummary, placement: ShellSessionPlacement) => {
    if (!api || !markShellBusy(shell.name)) return;
    setActionError(null);
    const patch = placement === "active" && shell.latestSeq !== undefined && shell.latestSeq !== null
      ? { placement, lastSeenSeq: shell.latestSeq }
      : { placement };
    const ok = await patchUiState(api, shell.name, patch);
    if (!ok) setActionError("Could not update shell");
    if (placement === "active" && ok) {
      showShellDetail(
        shell.latestSeq !== undefined && shell.latestSeq !== null
          ? { ...shell, placement, lastSeenSeq: shell.latestSeq }
          : { ...shell, placement },
      );
    }
    clearShellBusy(shell.name);
  };

  const copyAttachCommand = async (shell: ShellSessionSummary) => {
    try {
      await navigator.clipboard.writeText(attachCommand(shell));
    } catch (err: unknown) {
      console.error("[terminal] Failed to copy shell attach command:", err);
      setActionError("Could not copy attach command");
    }
  };

  const startRename = (shell: ShellSessionSummary) => {
    setRenamingName(shell.name);
    setRenameDraft(shell.name);
    setRenameError(null);
  };

  const commitRename = async () => {
    if (!api || !renamingName) return;
    const originalName = renamingName;
    const nextName = renameDraft.trim();
    if (!isValidShellSessionName(nextName)) {
      setRenameError(RENAME_HELP);
      return;
    }
    const renameBusyNames = [originalName, nextName];
    if (!markShellsBusy(renameBusyNames)) return;
    const ok = await rename(api, originalName, nextName);
    clearShellsBusy(renameBusyNames);
    if (!ok) {
      if (renamingNameRef.current === originalName) setRenameError("Could not rename shell");
      return;
    }
    renameTerminalSession(originalName, nextName);
    setOpenedSessionNames((current) => current.map((name) => name === originalName ? nextName : name));
    setLiveSessionName((current) => current === originalName ? nextName : current);
    if (selectedRef.current === originalName) setSelectedName(nextName);
    if (renamingNameRef.current === originalName) {
      setRenameError(null);
      setRenamingName((current) => (current === originalName ? null : current));
    }
  };

  const confirmDelete = async () => {
    if (!api || !deleteTarget) return;
    const name = deleteTarget.name;
    if (!markShellBusy(name)) return;
    setActionError(null);
    const ok = await deleteSession(api, name);
    clearShellBusy(name);
    setDeleteTarget(null);
    if (!ok) {
      setActionError("Could not delete shell");
      return;
    }
    reconcileShellSessionSnapshot(
      useShellSessions.getState().sessions.filter((session) => session.name !== name),
    );
    if (selectedRef.current === name) {
      setSelectedName(null);
    }
    setOpenedSessionNames((current) => current.filter((openedName) => openedName !== name));
    setLiveSessionName((current) => current === name ? null : current);
  };

  const finishDrag = () => {
    draggingNameRef.current = null;
    draggingPlacementRef.current = null;
  };

  const dropOnShell = (target: ShellSessionSummary) => {
    const draggingName = draggingNameRef.current;
    const draggingPlacement = draggingPlacementRef.current;
    if (!api || !draggingName || draggingName === target.name) {
      finishDrag();
      return;
    }
    if (draggingPlacement !== placementFor(target, openShellNames)) {
      finishDrag();
      return;
    }
    void reorder(api, draggingName, target.name);
    finishDrag();
  };

  const overviewSelected = selected === null;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" style={{ background: SURFACE_BASE_BACKGROUND }}>
      <div className="w-[280px] min-w-[200px] max-w-[280px] shrink-0 border-r" style={{ borderColor: "var(--border-default, #F3F2F2)" }}>
        <TerminalSessionSidebar
          sessions={shells}
          selectedName={selectedName}
          creating={creating}
          disabled={!api}
          onCreate={() => void createShell()}
          onSelect={showShellDetail}
          onDelete={setDeleteTarget}
        />
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <RetainedPane
          as="section"
          active={active && overviewSelected}
          visible={visible && overviewSelected}
          className="absolute inset-0 flex min-h-0 flex-col overflow-hidden rounded-lg"
          background={SURFACE_BASE_BACKGROUND}
          style={{ borderRadius: 8 }}
        >
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div data-terminal-overview className="flex w-full max-w-md flex-col">
              {loading && shells.length === 0 ? (
                <div role="status" aria-label="Loading terminal sessions" className="flex flex-1 items-center justify-center gap-2 py-16" style={{ color: "var(--text-secondary)" }}>
                  <RefreshCw className="status-pulse" size={16} aria-hidden="true" />
                  <span className="text-sm">Loading terminal sessions…</span>
                </div>
              ) : error && shells.length === 0 ? (
                <EmptyState
                  icon={<SquareTerminal size={26} />}
                  headline="Terminal sessions unavailable"
                  description={categoryMessage(error)}
                  action={
                    <Button
                      variant="subtle"
                      aria-label="Retry terminal sessions"
                      disabled={!api}
                      onClick={() => api && void syncShellSessions(api)}
                    >
                      <RefreshCw size={13} />
                      Retry
                    </Button>
                  }
                />
              ) : shells.length === 0 ? (
                <ShellListEmpty />
              ) : (
                null
              )}
          </div>
        </div>
        </RetainedPane>

        {visibleSessionNames.map((sessionName) => {
          const shell = shells.find((candidate) => candidate.name === sessionName) ?? { name: sessionName, status: "active" as const };
          const selected = selectedName === sessionName;
          const statusLabel = shellStatusLabel(shell);
          const activeStatus = statusLabel === "Active";
          return (
            <RetainedPane
              as="section"
              key={sessionName}
              active={active && selected}
              visible={visible && selected}
              className="absolute inset-0 flex min-h-0 flex-col overflow-hidden rounded-lg"
              background={SURFACE_BASE_BACKGROUND}
              style={{ borderRadius: 8 }}
            >
            <header
              className="flex shrink-0 items-center justify-between border-b px-4 py-4"
              style={{ borderColor: "var(--border-default, #F3F2F2)", background: SURFACE_BASE_BACKGROUND }}
            >
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-xs font-medium leading-[19.5px]" style={{ color: "var(--text-primary)" }}>{shellTitle(shell)}</h1>
                <p className="mt-1 truncate text-xs leading-4 tracking-[0.12px]" style={{ color: "var(--text-tertiary)" }}>
                  Started at {sessionStart(shell.createdAt)} · {runtimeSlot === "primary" ? "main computer" : runtimeSlot}
                </p>
              </div>
              <span
                className="inline-flex h-5 items-center justify-center rounded-[26px] border px-2 py-0.5 text-xs font-medium leading-4"
                style={{
                  borderColor: activeStatus ? "var(--border-success, #34B275)" : "var(--border-default, #F3F2F2)",
                  background: activeStatus ? "var(--surface-success, #EEF7F2)" : "var(--surface-tertiary, #E1E0E0)",
                  color: "var(--text-primary)",
                }}
              >
                {statusLabel}
              </span>
            </header>
            <div data-terminal-detail className="flex min-h-0 flex-1">
              <div
                data-terminal-viewport
                className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
                style={{ background: SURFACE_BASE_BACKGROUND }}
              >
                <TerminalView
                  sessionName={sessionName}
                  active={active && liveSessionName === sessionName}
                  themeMode={terminalAppearanceMode}
                />
              </div>
            </div>
            </RetainedPane>
          );
        })}
      </div>
      </div>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        width={360}
        placement="center"
      >
        <div className="flex flex-col gap-3 p-4">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Delete {deleteTarget?.name}?
            </h2>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              This closes the shell session and detaches any clients.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" disabled={!deleteTarget || isShellBusy(deleteTarget.name)} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function ShellListEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center" style={{ borderColor: "var(--border-subtle)" }}>
      <SquareTerminal size={22} style={{ color: "var(--text-tertiary)" }} />
      <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>No shell sessions yet</p>
      <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Start a shell to attach from the Mac Terminal.</p>
    </div>
  );
}

function ShellCard({
  shell,
  busy,
  placement,
  renaming,
  renameDraft,
  renameError,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onOpen,
  onOpenInTab,
  onMove,
  onRename,
  onDelete,
  onCopy,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  shell: ShellSessionSummary;
  busy: boolean;
  placement: ShellSessionPlacement;
  renaming: boolean;
  renameDraft: string;
  renameError: string | null;
  onRenameDraft: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onOpen: () => void;
  onOpenInTab: () => void;
  onMove: (placement: ShellSessionPlacement) => void;
  onRename: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  return (
    <li
      data-testid={`shell-card-${shell.name}`}
      className="group/shell relative flex min-h-16 items-center border-b px-4 hover:bg-[var(--bg-hover)]"
      style={{ borderColor: "var(--border-subtle)" }}
      onDragEnter={(event) => {
        event.preventDefault();
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      {renaming ? (
        <div data-shell-rename-editor className="flex w-full flex-col gap-1 py-2">
          <div className="flex items-center gap-1">
            <input
              aria-label="Shell name"
              value={renameDraft}
              onChange={(event) => onRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCommitRename();
                if (event.key === "Escape") onCancelRename();
              }}
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 font-mono text-xs outline-none"
              style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
              disabled={busy}
            />
            <IconButton label="Save shell name" disabled={busy} onClick={onCommitRename}>
              <Check size={13} />
            </IconButton>
            <IconButton label="Cancel rename" disabled={busy} onClick={onCancelRename}>
              <X size={13} />
            </IconButton>
          </div>
          {renameError ? <span className="text-xs" style={{ color: "var(--danger)" }}>{renameError}</span> : null}
        </div>
      ) : (
        <div className="flex min-h-9 w-full items-center">
        <button
          type="button"
          aria-label={`Drag ${shell.name}`}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="absolute left-0 top-1/2 flex h-7 w-5 -translate-y-1/2 items-center justify-center rounded opacity-0 transition-opacity group-hover/shell:opacity-100 focus:opacity-100"
          style={{ color: "var(--text-tertiary)" }}
        >
          <GripVertical size={13} />
        </button>
        <button
          type="button"
          aria-label={`Open ${shell.name}`}
          disabled={busy}
          className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_108px] items-center gap-5 text-left disabled:opacity-50"
          onClick={onOpen}
        >
          <span className="min-w-0">
            <span className="block truncate text-base font-medium" style={{ color: "var(--text-primary)" }}>{shellTitle(shell)}</span>
            {shellTitle(shell) !== shell.name ? (
              <span className="mt-0.5 block truncate font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>{shell.name}</span>
            ) : null}
          </span>
          <span className="inline-flex h-5 items-center rounded-full border px-2 text-[11px]" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            {shellStatusLabel(shell)}
          </span>
          <span className="w-[92px] text-right text-xs" style={{ color: "var(--text-tertiary)" }}>
            {relativeSessionActivity(shell.updatedAt)}
          </span>
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${shell.name}`}
              disabled={busy}
              className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-[var(--bg-active)] group-hover/shell:opacity-100 focus:opacity-100 disabled:opacity-30"
              style={{ color: "var(--text-tertiary)" }}
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              aria-label={`Actions for ${shell.name}`}
              align="end"
              sideOffset={5}
              className="fade-in min-w-[190px] rounded-lg border p-1"
              style={{
                zIndex: DESKTOP_Z_INDEX.popover,
                background: "var(--bg-overlay)",
                borderColor: "var(--border-default)",
                boxShadow: "var(--shadow-2)",
              }}
            >
              <ShellMenuItem icon={<ExternalLink size={13} />} label="Open in Terminal tab" onSelect={onOpenInTab} />
              <ShellMenuItem
                icon={placement === "active" ? <Layers size={13} /> : <SquareTerminal size={13} />}
                label={placement === "active" ? "Move to background" : "Make active"}
                onSelect={() => onMove(placement === "active" ? "background" : "active")}
              />
              <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
              <ShellMenuItem icon={<Edit3 size={13} />} label="Rename" onSelect={onRename} />
              <ShellMenuItem icon={<Clipboard size={13} />} label="Copy attach command" onSelect={onCopy} />
              <ShellMenuItem icon={<Trash2 size={13} />} label="Delete" danger onSelect={onDelete} />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        </div>
      )}

    </li>
  );
}

function ShellMenuItem({
  icon,
  label,
  danger = false,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]"
      style={{ color: danger ? "var(--danger)" : "var(--text-primary)" }}
    >
      {icon}
      {label}
    </DropdownMenu.Item>
  );
}
