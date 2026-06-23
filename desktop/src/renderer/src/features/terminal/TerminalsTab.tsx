import {
  Check,
  Clipboard,
  Edit3,
  GripVertical,
  Layers,
  Play,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, EmptyState, IconButton, StatusDot } from "../../design/primitives";
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

interface ShellGroup {
  key: ShellSessionPlacement;
  label: string;
  shells: ShellSessionSummary[];
}

const RENAME_HELP = "Use lowercase letters, numbers, and hyphens. Start and end with a letter or number.";

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
  if (shell.status === "exited") return "ended";
  if (shell.visualStatus) return shell.visualStatus;
  return shell.status ?? "active";
}

function tabSummary(shell: ShellSessionSummary): string {
  if (!shell.tabs || shell.tabs.length === 0) return "tabs unknown";
  return `${shell.tabs.length} tab${shell.tabs.length === 1 ? "" : "s"}`;
}

function placementFor(shell: ShellSessionSummary, openShellNames: Set<string>): ShellSessionPlacement {
  return shell.placement ?? (openShellNames.has(shell.name) ? "active" : "background");
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- TerminalsTab is the cohesive shell-session workspace: network load/create, selection, rename, delete confirmation, search, and drag refs are independent UI concerns. A reducer would couple unrelated state transitions without reducing render risk; extracting subcomponents below keeps the row/empty states isolated.
export default function TerminalsTab() {
  const api = useConnection((s) => s.api);
  const shells = useShellSessions((s) => s.sessions);
  const loading = useShellSessions((s) => s.loading);
  const creating = useShellSessions((s) => s.creating);
  const error = useShellSessions((s) => s.error);
  const load = useShellSessions((s) => s.load);
  const create = useShellSessions((s) => s.create);
  const deleteSession = useShellSessions((s) => s.deleteSession);
  const rename = useShellSessions((s) => s.rename);
  const reorder = useShellSessions((s) => s.reorder);
  const patchUiState = useShellSessions((s) => s.patchUiState);
  const tabs = useTabs((s) => s.tabs);
  const openTab = useTabs((s) => s.openTab);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyName, setBusyName] = useState<string | null>(null);
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

  const openShellNames = useMemo(
    () => new Set(tabs.flatMap((tab) => (tab.kind === "terminal" && tab.sessionName ? [tab.sessionName] : []))),
    [tabs],
  );

  const filteredShells = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return shells;
    return shells.filter((shell) =>
      [
        shell.name,
        shell.status,
        shell.visualStatus,
        shell.attachCommand,
        shell.tabs?.map((tab) => tab.name).join(" "),
      ].filter(Boolean).join(" ").toLowerCase().includes(normalized),
    );
  }, [query, shells]);

  const groups = useMemo<ShellGroup[]>(() => {
    const active: ShellSessionSummary[] = [];
    const background: ShellSessionSummary[] = [];
    for (const shell of filteredShells) {
      if (placementFor(shell, openShellNames) === "active") active.push(shell);
      else background.push(shell);
    }
    return [
      { key: "active", label: "Active", shells: active },
      { key: "background", label: "Background", shells: background },
    ];
  }, [filteredShells, openShellNames]);

  const selectedShell = shells.find((shell) => shell.name === selectedName) ?? shells[0] ?? null;
  const selected = selectedShell?.name ?? null;

  const createShell = async () => {
    if (!api || creating) return;
    setActionError(null);
    const created = await create(api);
    if (!created) {
      setActionError("Could not create shell");
      return;
    }
    setSelectedName(created.name);
  };

  const openShell = (shell: ShellSessionSummary) => {
    setSelectedName(shell.name);
    openTab({ kind: "terminal", sessionName: shell.name, title: shell.name });
    if (shell.latestSeq !== undefined && shell.latestSeq !== null && shell.lastSeenSeq !== shell.latestSeq && api) {
      void patchUiState(api, shell.name, { lastSeenSeq: shell.latestSeq });
    }
  };

  const moveShell = async (shell: ShellSessionSummary, placement: ShellSessionPlacement) => {
    if (!api || busyName) return;
    setBusyName(shell.name);
    setActionError(null);
    const patch = placement === "active" && shell.latestSeq !== undefined && shell.latestSeq !== null
      ? { placement, lastSeenSeq: shell.latestSeq }
      : { placement };
    const ok = await patchUiState(api, shell.name, patch);
    if (!ok) setActionError("Could not update shell");
    if (placement === "active" && ok) openShell(shell);
    setBusyName(null);
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
    const nextName = renameDraft.trim();
    if (!isValidShellSessionName(nextName)) {
      setRenameError(RENAME_HELP);
      return;
    }
    setBusyName(renamingName);
    const ok = await rename(api, renamingName, nextName);
    setBusyName(null);
    if (!ok) {
      setRenameError("Could not rename shell");
      return;
    }
    if (selected === renamingName) setSelectedName(nextName);
    setRenamingName(null);
    setRenameError(null);
  };

  const confirmDelete = async () => {
    if (!api || !deleteTarget || busyName) return;
    const name = deleteTarget.name;
    setBusyName(name);
    setActionError(null);
    const ok = await deleteSession(api, name);
    setBusyName(null);
    setDeleteTarget(null);
    if (!ok) {
      setActionError("Could not delete shell");
      return;
    }
    if (selected === name) {
      const next = useShellSessions.getState().sessions.find((shell) => shell.name !== name);
      setSelectedName(next?.name ?? null);
    }
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

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="flex w-[320px] shrink-0 flex-col border-r"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
          <SquareTerminal size={15} style={{ color: "var(--text-secondary)" }} />
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Shells</span>
          <div className="flex-1" />
          <IconButton label="Refresh shells" onClick={() => api && void load(api)}>
            <RefreshCw size={13} />
          </IconButton>
          <Button variant="primary" disabled={!api || creating} onClick={() => void createShell()} aria-label="New shell">
            <Plus size={13} />
            {creating ? "Starting" : "New shell"}
          </Button>
        </div>

        <div className="border-b p-2" style={{ borderColor: "var(--border-subtle)" }}>
          <label
            className="flex h-8 items-center gap-2 rounded-md border px-2"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}
          >
            <Search size={13} style={{ color: "var(--text-tertiary)" }} />
            <input
              aria-label="Filter shells"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search shells"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              style={{ color: "var(--text-primary)" }}
            />
          </label>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {error ? (
            <p className="rounded-md px-2.5 py-2 text-xs" style={{ color: "var(--danger)", background: "var(--danger-muted)" }}>
              {categoryMessage(error)}
            </p>
          ) : null}
          {actionError ? (
            <p role="status" className="rounded-md px-2.5 py-2 text-xs" style={{ color: "var(--danger)", background: "var(--danger-muted)" }}>
              {actionError}
            </p>
          ) : null}
          {loading && shells.length === 0 ? (
            <p className="px-2.5 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>Loading shells...</p>
          ) : shells.length === 0 && !error ? (
            <ShellListEmpty onCreate={createShell} creating={creating} disabled={!api} />
          ) : filteredShells.length === 0 ? (
            <p className="px-2.5 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>No shells match your search.</p>
          ) : (
            groups.map((group) => (
              <section key={group.key} data-testid={`shell-group-${group.key}`} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 px-1.5 pt-1">
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>
                    {group.label}
                  </span>
                  <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{group.shells.length}</span>
                </div>
                {group.shells.length === 0 ? (
                  <p className="px-1.5 py-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
                    {group.key === "active" ? "No active shells." : "No background shells."}
                  </p>
                ) : (
                  group.shells.map((shell) => (
                    <ShellCard
                      key={shell.name}
                      shell={shell}
                      selected={shell.name === selected}
                      busy={busyName === shell.name}
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
                      onSelect={() => setSelectedName(shell.name)}
                      onOpen={() => openShell(shell)}
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
                  ))
                )}
              </section>
            ))
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedShell ? (
          <>
            <div
              className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
            >
              <StatusDot color={statusColor(selectedShell)} pulse={selectedShell.status !== "exited"} />
              <span className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{selectedShell.name}</span>
              <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{shellStatusLabel(selectedShell)}</span>
              <div className="flex-1" />
              <span className="font-mono text-xs" style={{ color: "var(--text-tertiary)" }}>{attachCommand(selectedShell)}</span>
            </div>
            <TerminalView key={selectedShell.name} sessionName={selectedShell.name} active />
          </>
        ) : (
          <EmptyState
            icon={<SquareTerminal size={26} />}
            headline="No shell selected"
            description="Pick a shell on the left or start a new one."
            action={
              <Button variant="primary" disabled={!api || creating} onClick={() => void createShell()}>
                <Plus size={13} />
                New shell
              </Button>
            }
          />
        )}
      </div>

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} width={360}>
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
            <Button variant="danger" disabled={!deleteTarget || busyName === deleteTarget.name} onClick={() => void confirmDelete()}>
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
  selected,
  busy,
  placement,
  renaming,
  renameDraft,
  renameError,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onSelect,
  onOpen,
  onMove,
  onRename,
  onDelete,
  onCopy,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  shell: ShellSessionSummary;
  selected: boolean;
  busy: boolean;
  placement: ShellSessionPlacement;
  renaming: boolean;
  renameDraft: string;
  renameError: string | null;
  onRenameDraft: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSelect: () => void;
  onOpen: () => void;
  onMove: (placement: ShellSessionPlacement) => void;
  onRename: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  return (
    <div
      data-testid={`shell-card-${shell.name}`}
      className="group/shell rounded-md border px-2 py-2 transition-colors duration-100"
      style={{
        borderColor: selected ? "var(--accent)" : "var(--border-subtle)",
        background: selected ? "var(--bg-selected)" : "var(--bg-overlay)",
      }}
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
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-label={`Drag ${shell.name}`}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="mt-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded"
          style={{ color: "var(--text-tertiary)" }}
        >
          <GripVertical size={13} />
        </button>
        <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={onSelect}>
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot color={statusColor(shell)} pulse={shell.status !== "exited" && selected} />
            <span className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{shell.name}</span>
            {shell.unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--accent)" }} /> : null}
          </span>
          <span className="mt-0.5 truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
            {shellStatusLabel(shell)} · {tabSummary(shell)}
            {typeof shell.attachedClients === "number" ? ` · ${shell.attachedClients} attached` : ""}
          </span>
        </button>
      </div>

      {renaming ? (
        <div className="mt-2 flex flex-col gap-1 pl-7">
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

      <div className="mt-2 flex items-center gap-1 pl-7 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/shell:opacity-100">
        <IconButton label={`Open ${shell.name}`} disabled={busy} onClick={onOpen}>
          <Play size={13} />
        </IconButton>
        {placement === "active" ? (
          <IconButton label={`Move ${shell.name} to background`} disabled={busy} onClick={() => onMove("background")}>
            <Layers size={13} />
          </IconButton>
        ) : (
          <IconButton label={`Make ${shell.name} active`} disabled={busy} onClick={() => onMove("active")}>
            <SquareTerminal size={13} />
          </IconButton>
        )}
        <IconButton label={`Rename ${shell.name}`} disabled={busy} onClick={onRename}>
          <Edit3 size={13} />
        </IconButton>
        <IconButton label={`Copy attach command for ${shell.name}`} disabled={busy} onClick={onCopy}>
          <Clipboard size={13} />
        </IconButton>
        <IconButton label={`Delete ${shell.name}`} disabled={busy} onClick={onDelete}>
          <Trash2 size={13} />
        </IconButton>
      </div>
    </div>
  );
}
