import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  Check,
  Clipboard,
  Edit3,
  ExternalLink,
  GripVertical,
  Layers,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, EmptyState, IconButton, StatusDot } from "../../design/primitives";
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
import TerminalView from "./TerminalView";

const RENAME_HELP = "Use lowercase letters, numbers, and hyphens. Start and end with a letter or number.";
const SESSION_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
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

function statusColor(shell: ShellSessionSummary): string {
  if (shell.status === "exited" || shell.visualStatus === "finished") return "var(--status-todo)";
  if (shell.visualStatus === "waiting") return "var(--warning)";
  if (shell.visualStatus === "idle") return "var(--text-tertiary)";
  return "var(--status-complete)";
}

function shellStatusLabel(shell: ShellSessionSummary): string {
  if (shell.status === "exited" || shell.visualStatus === "finished") return "Closed";
  if (shell.status === "degraded" || shell.visualStatus === "waiting") return "Waiting";
  return "Active";
}

function shellTitle(shell: ShellSessionSummary): string {
  return shell.subtitle?.trim() || shell.lastAction?.trim() || shell.name;
}

function relativeActivity(updatedAt: string | undefined, now = Date.now()): string {
  if (!updatedAt) return "Activity unknown";
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "Activity unknown";
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return SESSION_DAY_FORMATTER.format(timestamp);
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

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- TerminalsTab is the cohesive shell-session workspace: network load/create, selection, rename, delete confirmation, search, and drag refs are independent UI concerns. A reducer would couple unrelated state transitions without reducing render risk; extracting subcomponents below keeps the row/empty states isolated.
export default function TerminalsTab({ active = true }: { active?: boolean }) {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const shells = useShellSessions((s) => s.sessions);
  const loading = useShellSessions((s) => s.loading);
  const creating = useShellSessions((s) => s.creating);
  const error = useShellSessions((s) => s.error);
  const loadSequence = useShellSessions((s) => s.loadSequence);
  const load = useShellSessions((s) => s.load);
  const create = useShellSessions((s) => s.create);
  const deleteSession = useShellSessions((s) => s.deleteSession);
  const rename = useShellSessions((s) => s.rename);
  const reorder = useShellSessions((s) => s.reorder);
  const patchUiState = useShellSessions((s) => s.patchUiState);
  const tabs = useTabs((s) => s.tabs);
  const openTab = useTabs((s) => s.openTab);
  const recordRecentTerminal = useTabs((s) => s.recordRecentTerminal);
  const removeRecentView = useTabs((s) => s.removeRecentView);
  const reconcileRecentTerminals = useTabs((s) => s.reconcileRecentTerminals);
  const terminalSessionRequest = useTabs((s) => s.terminalSessionRequest);
  const consumeTerminalSessionRequest = useTabs((s) => s.consumeTerminalSessionRequest);
  const renameTerminalSession = useTabs((s) => s.renameTerminalSession);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [liveSessionName, setLiveSessionName] = useState<string | null>(null);
  const [openedSessionNames, setOpenedSessionNames] = useState<string[]>([]);
  const [sessionRailOpen, setSessionRailOpen] = useState(true);
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
    if (api) void load(api);
  }, [api, load]);

  useEffect(() => {
    if (loading || error || loadSequence === 0) return;
    reconcileRecentTerminals(shells.map((shell) => shell.name));
  }, [error, loading, loadSequence, reconcileRecentTerminals, shells]);

  const openShellNames = useMemo(
    () => new Set([
      ...tabs.flatMap((tab) => (tab.kind === "terminal" && tab.sessionName ? [tab.sessionName] : [])),
      ...(liveSessionName ? [liveSessionName] : []),
    ]),
    [liveSessionName, tabs],
  );

  const filteredShells = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return shells;
    return shells.filter((shell) =>
      [
        shell.name,
        shell.status,
        shell.visualStatus,
        shell.subtitle,
        shell.lastAction,
        shell.attachCommand,
        shell.tabs?.map((tab) => tab.name).join(" "),
      ].filter(Boolean).join(" ").toLowerCase().includes(normalized),
    );
  }, [query, shells]);

  const selectedShell = selectedName ? shells.find((shell) => shell.name === selectedName) ?? null : null;
  const selected = selectedShell?.name ?? selectedName;
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
    if (!terminalSessionRequest) return;
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

  const showShellList = () => {
    setSelectedName(null);
    setLiveSessionName(null);
  };

  const openShellInTab = (shell: ShellSessionSummary) => {
    openTab({ kind: "terminal", sessionName: shell.name, title: shell.name });
    if (shell.latestSeq !== undefined && shell.latestSeq !== null && shell.lastSeenSeq !== shell.latestSeq && api) {
      void patchUiState(api, shell.name, { lastSeenSeq: shell.latestSeq });
    }
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
    removeRecentView("terminal", name);
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

  const overviewVisible = active && selectedName === null;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" style={{ background: "var(--bg-surface)" }}>
      <RetainedPane
        as="section"
        active={overviewVisible}
        className="absolute inset-0 flex min-h-0 flex-col"
        background="var(--bg-surface)"
      >
        <nav
          aria-label="Terminal breadcrumb"
          className="flex h-10 shrink-0 items-center gap-1.5 border-b px-4 text-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}
        >
          <span>Home</span>
          <span aria-hidden="true">›</span>
          <span style={{ color: "var(--text-secondary)" }}>Terminal</span>
        </nav>

        <div className="mx-auto flex min-h-0 w-full max-w-[960px] flex-1 flex-col px-8 pb-8 pt-5">
          <div className="flex shrink-0 items-center gap-2 pb-4">
            <h1 className="text-2xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>Terminal</h1>
            <div className="flex-1" />
            <IconButton
              label="Search terminal sessions"
              active={searchOpen}
              onClick={() => {
                setSearchOpen((open) => !open);
                if (searchOpen) setQuery("");
              }}
            >
              <Search size={14} />
            </IconButton>
            <Button variant="primary" disabled={!api || creating} onClick={() => void createShell()} aria-label="New shell">
              <Plus size={13} />
              {creating ? "Starting" : "New"}
            </Button>
          </div>

          {searchOpen ? (
            <label
              className="mb-3 flex h-9 shrink-0 items-center gap-2 rounded-md border px-3"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}
            >
              <Search size={14} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
              <input
                autoFocus
                aria-label="Search terminal sessions"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sessions"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                style={{ color: "var(--text-primary)" }}
              />
            </label>
          ) : null}

          {actionError ? (
            <p role="status" className="mb-3 rounded-md px-3 py-2 text-xs" style={{ color: "var(--danger)", background: "var(--danger-muted)" }}>
              {actionError}
            </p>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
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
                  <Button variant="subtle" aria-label="Retry terminal sessions" disabled={!api} onClick={() => api && void load(api)}>
                    <RefreshCw size={13} />
                    Retry
                  </Button>
                }
              />
            ) : shells.length === 0 ? (
              <ShellListEmpty onCreate={createShell} creating={creating} disabled={!api} />
            ) : filteredShells.length === 0 ? (
              <EmptyState
                icon={<Search size={24} />}
                headline="No matching sessions"
                description="Try a different search term."
              />
            ) : (
              <ul aria-label="Terminal sessions">
                {filteredShells.map((shell) => (
                  <ShellCard
                    key={shell.name}
                    shell={shell}
                    busy={isShellBusy(shell.name)}
                    placement={placementFor(shell, openShellNames)}
                    renaming={renamingName === shell.name}
                    renameDraft={renameDraft}
                    renameError={renameError}
                    onRenameDraft={setRenameDraft}
                    onCommitRename={() => void commitRename()}
                    onCancelRename={() => {
                      setRenamingName(null);
                      setRenameError(null);
                    }}
                    onOpen={() => showShellDetail(shell)}
                    onOpenInTab={() => openShellInTab(shell)}
                    onMove={(placement) => void moveShell(shell, placement)}
                    onRename={() => startRename(shell)}
                    onDelete={() => setDeleteTarget(shell)}
                    onCopy={() => void copyAttachCommand(shell)}
                    onDragStart={() => {
                      draggingNameRef.current = shell.name;
                      draggingPlacementRef.current = placementFor(shell, openShellNames);
                    }}
                    onDragEnd={finishDrag}
                    onDrop={() => dropOnShell(shell)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </RetainedPane>

      {openedSessionNames.map((sessionName) => {
        const shell = shells.find((candidate) => candidate.name === sessionName) ?? { name: sessionName, status: "active" as const };
        const visible = active && selectedName === sessionName;
        return (
          <RetainedPane
            as="section"
            key={sessionName}
            active={visible}
            className="absolute inset-0 flex min-h-0 flex-col"
            background="var(--bg-surface)"
          >
            <nav
              aria-label="Terminal breadcrumb"
              className="flex h-10 shrink-0 items-center gap-1.5 border-b px-4 text-xs"
              style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}
            >
              <span>Home</span>
              <span aria-hidden="true">›</span>
              <button
                type="button"
                aria-label="Terminal sessions breadcrumb"
                className="rounded px-1 py-0.5 hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--text-secondary)" }}
                onClick={showShellList}
              >
                Terminal
              </button>
              <span aria-hidden="true">›</span>
              <span className="min-w-0 truncate" style={{ color: "var(--text-primary)" }}>{sessionName}</span>
            </nav>

            <header className="flex shrink-0 items-center gap-3 border-b px-5 py-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
              <IconButton label="Back to terminal sessions" onClick={showShellList}>
                <ArrowLeft size={14} />
              </IconButton>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{shellTitle(shell)}</h1>
                <p className="mt-0.5 truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                  Started at {sessionStart(shell.createdAt)} · {runtimeSlot === "primary" ? "main computer" : runtimeSlot}
                </p>
              </div>
              <IconButton
                label={sessionRailOpen ? "Collapse terminal sessions" : "Show terminal sessions"}
                onClick={() => setSessionRailOpen((open) => !open)}
              >
                {sessionRailOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
              </IconButton>
              <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
                <StatusDot color={statusColor(shell)} pulse={shell.status !== "exited" && shell.visualStatus === "running"} />
                {shellStatusLabel(shell)}
              </span>
            </header>
            <div data-terminal-detail className="flex min-h-0 flex-1">
              {sessionRailOpen ? (
                <nav
                  aria-label="Terminal session switcher"
                  className="flex w-48 shrink-0 flex-col overflow-hidden border-r"
                  style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}
                >
                  <div
                    className="shrink-0 border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
                    style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}
                  >
                    Sessions
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                    {shells.map((candidate) => {
                      const current = candidate.name === sessionName;
                      return (
                        <button
                          key={candidate.name}
                          type="button"
                          aria-label={`Switch to ${candidate.name}`}
                          aria-current={current ? "page" : undefined}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                          style={{
                            background: current ? "var(--bg-selected)" : "transparent",
                            color: current ? "var(--text-primary)" : "var(--text-secondary)",
                          }}
                          onClick={() => showShellDetail(candidate)}
                        >
                          <StatusDot
                            color={statusColor(candidate)}
                            pulse={candidate.status !== "exited" && candidate.visualStatus === "running"}
                          />
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">
                            {candidate.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </nav>
              ) : null}
              <div
                data-terminal-viewport
                className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
                style={{ background: "var(--bg-app)" }}
              >
                <TerminalView sessionName={sessionName} active={active && liveSessionName === sessionName} />
              </div>
            </div>
          </RetainedPane>
        );
      })}

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

function ShellListEmpty({
  onCreate,
  creating,
  disabled,
}: {
  onCreate: () => void;
  creating: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center" style={{ borderColor: "var(--border-subtle)" }}>
      <SquareTerminal size={22} style={{ color: "var(--text-tertiary)" }} />
      <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>No shell sessions yet</p>
      <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Start a shell to attach from the Mac Terminal.</p>
      <Button variant="subtle" disabled={disabled || creating} onClick={() => void onCreate()}>
        <Plus size={13} />
        New shell
      </Button>
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
      className="group/shell relative border-b px-3 py-2.5 last:border-b-0 hover:bg-[var(--bg-hover)]"
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
      <div className="flex min-h-9 items-center gap-2">
        <button
          type="button"
          aria-label={`Drag ${shell.name}`}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="flex h-7 w-5 shrink-0 items-center justify-center rounded opacity-40 transition-opacity group-hover/shell:opacity-100 focus:opacity-100"
          style={{ color: "var(--text-tertiary)" }}
        >
          <GripVertical size={13} />
        </button>
        <button
          type="button"
          aria-label={`Open ${shell.name}`}
          disabled={busy}
          className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-5 text-left disabled:opacity-50"
          onClick={onOpen}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{shellTitle(shell)}</span>
            {shellTitle(shell) !== shell.name ? (
              <span className="mt-0.5 block truncate font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>{shell.name}</span>
            ) : null}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            <StatusDot color={statusColor(shell)} pulse={shell.visualStatus === "running"} />
            {shellStatusLabel(shell)}
          </span>
          <span className="w-[92px] text-right text-xs" style={{ color: "var(--text-tertiary)" }}>
            {relativeActivity(shell.updatedAt)}
          </span>
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${shell.name}`}
              disabled={busy}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-60 transition-opacity hover:bg-[var(--bg-active)] group-hover/shell:opacity-100 focus:opacity-100 disabled:opacity-30"
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
              <ShellMenuItem icon={<ExternalLink size={13} />} label="Open in tab" onSelect={onOpenInTab} />
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

      {renaming ? (
        <div className="mt-2 flex flex-col gap-1 pl-7 pr-9">
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
      ) : null}

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
