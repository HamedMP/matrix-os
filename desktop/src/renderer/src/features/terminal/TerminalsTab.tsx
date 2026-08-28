import { RefreshCw, SquareTerminal } from "@renderer/lib/hugeicons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, EmptyState } from "../../design/primitives";
import RetainedPane from "../../design/RetainedPane";
import { categoryMessage } from "../../../../shared/app-error";
import {
  type ShellSessionSummary,
  useShellSessions,
} from "../../stores/shell-sessions";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import {
  reconcileShellSessionSnapshot,
  syncShellSessions,
} from "../../lib/shell-session-sync";
import TerminalView from "./TerminalView";
import { TerminalSessionSidebar } from "./TerminalSessionSidebar";
import { useTerminalAppearance } from "../../stores/terminal-appearance";
import { DesktopTerminalThemePicker } from "./DesktopTerminalThemePicker";

const SESSION_START_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const MAX_PRESERVED_TERMINALS = 8;

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

function normalizeBusyNames(names: string[]): string[] {
  return names.filter((name, index) => name.length > 0 && names.indexOf(name) === index);
}

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
  const patchUiState = useShellSessions((s) => s.patchUiState);
  const terminalSessionRequest = useTabs((s) => s.terminalSessionRequest);
  const consumeTerminalSessionRequest = useTabs((s) => s.consumeTerminalSessionRequest);
  const terminalsTabId = useTabs((s) => s.tabs.find((tab) => tab.kind === "terminals")?.id);
  const renameTab = useTabs((s) => s.renameTab);
  const loadTerminalAppearance = useTerminalAppearance((s) => s.load);
  const [selectedName, setSelectedName] = useState<string | null>(() => mostRecentShell(shells)?.name ?? null);
  const [liveSessionName, setLiveSessionName] = useState<string | null>(null);
  const [openedSessionNames, setOpenedSessionNames] = useState<string[]>([]);
  const [busyNames, setBusyNames] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<ShellSessionSummary | null>(null);

  useEffect(() => {
    void loadTerminalAppearance(api);
  }, [api, loadTerminalAppearance]);

  useEffect(() => {
    if (loading || error || authoritativeRevision === 0) return;
    const liveNames = new Set(shells.map((shell) => shell.name));
    setOpenedSessionNames((current) => {
      const retained = current.filter((name) => liveNames.has(name));
      return retained.length === current.length ? current : retained;
    });
    setLiveSessionName((current) => current && liveNames.has(current) ? current : null);
    setSelectedName((current) => current && liveNames.has(current) ? current : null);
  }, [authoritativeRevision, error, loading, shells]);

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
    const created = await create(api);
    if (!created) return;
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

  const confirmDelete = async () => {
    if (!api || !deleteTarget) return;
    const name = deleteTarget.name;
    if (!markShellBusy(name)) return;
    const ok = await deleteSession(api, name);
    clearShellBusy(name);
    setDeleteTarget(null);
    if (!ok) return;
    reconcileShellSessionSnapshot(
      useShellSessions.getState().sessions.filter((session) => session.name !== name),
    );
    if (selectedRef.current === name) {
      setSelectedName(null);
    }
    setOpenedSessionNames((current) => current.filter((openedName) => openedName !== name));
    setLiveSessionName((current) => current === name ? null : current);
  };

  const overviewSelected = selected === null;

  return (
    <div
      data-testid="desktop-terminal-app"
      className="relative flex min-h-0 flex-1 overflow-hidden"
      style={{
        background: "var(--bg-app)",
        color: "var(--text-primary)",
      }}
    >
      <div className="w-[280px] min-w-[200px] max-w-[280px] shrink-0 border-r" style={{ borderColor: "var(--border-subtle)" }}>
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
          background="var(--bg-surface)"
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
              background="var(--bg-surface)"
              style={{ borderRadius: 8 }}
            >
            <header
              className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-4"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
            >
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-xs font-medium leading-[19.5px]" style={{ color: "var(--text-primary)" }}>{shellTitle(shell)}</h1>
                <p className="mt-1 truncate text-xs leading-4 tracking-[0.12px]" style={{ color: "var(--text-tertiary)" }}>
                  Started at {sessionStart(shell.createdAt)} · {runtimeSlot === "primary" ? "main computer" : runtimeSlot}
                </p>
              </div>
              <div data-terminal-header-actions className="no-drag relative flex shrink-0 items-center gap-2">
                <span
                  className="inline-flex h-5 items-center justify-center rounded-[26px] border px-2 py-0.5 text-xs font-medium leading-4"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-selected)",
                    color: activeStatus ? "var(--success)" : "var(--text-tertiary)",
                  }}
                >
                  {statusLabel}
                </span>
                <DesktopTerminalThemePicker />
              </div>
            </header>
            <div data-terminal-detail className="flex min-h-0 flex-1">
              <div
                data-terminal-viewport
                className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
                style={{ background: "var(--bg-surface)" }}
              >
                <TerminalView
                  sessionName={sessionName}
                  active={active && liveSessionName === sessionName}
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
