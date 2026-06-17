import { Plus, RefreshCw, RotateCcw, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, IconButton, StatusDot } from "../../design/primitives";
import { categoryMessage } from "../../../../shared/app-error";
import type { AttachableSession } from "../../lib/session-merge";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useSessions } from "../../stores/sessions";
import TerminalView from "./TerminalView";

interface SessionGroup {
  key: string;
  label: string;
  sessions: AttachableSession[];
}

// The Terminal workspace: an inner sidebar listing every VPS session grouped by
// the task it belongs to, with the selected one attached on the right. Mirrors
// the shell's terminal app, plus new/kill/restart controls.
export default function TerminalsTab() {
  const api = useConnection((s) => s.api);
  const sessions = useSessions((s) => s.sessions);
  const loading = useSessions((s) => s.loading);
  const error = useSessions((s) => s.error);
  const aliasMap = useSessions((s) => s.aliasMap);
  const load = useSessions((s) => s.load);
  const create = useSessions((s) => s.create);
  const kill = useSessions((s) => s.kill);
  const restart = useSessions((s) => s.restart);
  const creating = useSessions((s) => s.creating);
  const cardsByProject = useBoard((s) => s.cardsByProject);
  const projects = useBoard((s) => s.projects);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (api) void load(api);
  }, [api, load]);

  useEffect(() => {
    if (sessions.length === 0) {
      if (selected) setSelected(null);
      return;
    }
    if (!selected || !sessions.some((s) => s.attachName === selected)) {
      setSelected(sessions[0]?.attachName ?? null);
    }
  }, [sessions, selected]);

  // attachName -> task label, derived from board cards (no merge change needed).
  const taskByAttach = useMemo(() => {
    const map: Record<string, { title: string; projectSlug: string }> = {};
    for (const cards of Object.values(cardsByProject)) {
      for (const c of cards) {
        if (!c.linkedSessionId) continue;
        const attach = aliasMap[c.linkedSessionId];
        if (attach) map[attach] = { title: c.title, projectSlug: c.projectSlug };
      }
    }
    return map;
  }, [cardsByProject, aliasMap]);

  const projectName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of projects) m[p.slug] = p.name;
    return m;
  }, [projects]);

  const groups = useMemo<SessionGroup[]>(() => {
    const byProject = new Map<string, AttachableSession[]>();
    const other: AttachableSession[] = [];
    for (const s of sessions) {
      const task = taskByAttach[s.attachName];
      if (task) {
        const arr = byProject.get(task.projectSlug) ?? [];
        arr.push(s);
        byProject.set(task.projectSlug, arr);
      } else {
        other.push(s);
      }
    }
    const out: SessionGroup[] = [];
    for (const [slug, list] of byProject) {
      out.push({ key: slug, label: projectName[slug] ?? slug, sessions: list });
    }
    if (other.length > 0) out.push({ key: "__other__", label: "Other sessions", sessions: other });
    return out;
  }, [sessions, taskByAttach, projectName]);

  const labelFor = (s: AttachableSession) => taskByAttach[s.attachName]?.title ?? s.name;

  const newSession = async () => {
    if (!api || creating) return;
    setActionError(null);
    const created = await create(api, { kind: "shell" });
    if (created?.attachName) {
      setSelected(created.attachName);
      return;
    }
    if (created?.sessionId) {
      try {
        await api.delete(`/api/sessions/${encodeURIComponent(created.sessionId)}`);
      } catch (err: unknown) {
        console.error("[terminal] Failed to clean up unattached shell session:", err);
      }
    }
    setActionError("Start failed");
  };

  const killSession = async (attachName: string) => {
    if (!api || busy) return;
    setActionError(null);
    setBusy(attachName);
    try {
      const ok = await kill(api, attachName);
      if (!ok) setActionError("Kill failed");
    } finally {
      setBusy(null);
    }
  };

  const restartSession = async (attachName: string) => {
    if (!api || creating || busy !== null) return;
    setActionError(null);
    const restarted = await restart(api, attachName);
    if (restarted?.attachName) setSelected(restarted.attachName);
    else setActionError("Restart failed");
  };

  const selectedSession = sessions.find((s) => s.attachName === selected) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="flex w-[230px] shrink-0 flex-col border-r"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Sessions</span>
          <IconButton label="Refresh sessions" onClick={() => api && void load(api)}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {error ? (
            <p className="rounded-md px-2.5 py-2 text-xs" style={{ color: "var(--danger)", background: "var(--danger-muted)" }}>
              {categoryMessage(error)}
            </p>
          ) : null}
          {loading && sessions.length === 0 ? (
            <p className="px-2.5 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>Loading sessions...</p>
          ) : sessions.length === 0 && !error ? (
            <p className="px-2.5 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>No sessions on your computer yet.</p>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="mb-1 flex flex-col gap-0.5">
                <span className="px-2.5 pt-1.5 pb-0.5 text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
                  {group.label}
                </span>
                {group.sessions.map((s) => {
                  const active = s.attachName === selected;
                  const exited = s.status === "exited";
                  return (
                    <div
                      key={s.attachName}
                      className="group/session flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors duration-100"
                      style={{ background: active ? "var(--bg-selected)" : "transparent" }}
                      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                    >
                      <StatusDot color={exited ? "var(--status-todo)" : "var(--status-complete)"} pulse={!exited && active} />
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 flex-col text-left"
                        onClick={() => setSelected(s.attachName)}
                      >
                        <span className="truncate text-xs" style={{ color: "var(--text-primary)" }}>{labelFor(s)}</span>
                        <span className="truncate font-mono text-[10px]" style={{ color: "var(--text-tertiary)" }}>{s.name}</span>
                      </button>
                      {exited ? (
                        <IconButton label="Restart session" disabled={creating || busy !== null} onClick={() => void restartSession(s.attachName)}>
                          <RotateCcw size={12} />
                        </IconButton>
                      ) : null}
                      <button
                        type="button"
                        aria-label="Kill session"
                        title="Kill session"
                        disabled={creating || busy !== null}
                        onClick={() => void killSession(s.attachName)}
                        className="flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity group-hover/session:opacity-100 disabled:opacity-40"
                        style={{ color: "var(--text-tertiary)" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-tertiary)")}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t p-2" style={{ borderColor: "var(--border-subtle)" }}>
          {actionError ? (
            <p className="mb-2 text-xs" role="status" aria-live="polite" style={{ color: "var(--danger)" }}>
              {actionError}
            </p>
          ) : null}
          <Button variant="subtle" className="w-full justify-center" disabled={!api || creating} onClick={() => void newSession()}>
            <Plus size={13} />
            {creating ? "Starting…" : "New session"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedSession ? (
          <>
            <div
              className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
            >
              <StatusDot color={selectedSession.status === "exited" ? "var(--status-todo)" : "var(--status-complete)"} pulse={selectedSession.status !== "exited"} />
              <span className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{labelFor(selectedSession)}</span>
              <span className="truncate font-mono text-xs" style={{ color: "var(--text-tertiary)" }}>{selectedSession.name}</span>
              <div className="flex-1" />
              <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                {selectedSession.status === "exited" ? "Ended" : "Live"}
              </span>
            </div>
            <TerminalView key={selected ?? undefined} sessionName={selectedSession.attachName} active />
          </>
        ) : (
          <EmptyState
            icon={<SquareTerminal size={26} />}
            headline="No session selected"
            description="Pick a session on the left, start a new one, or open one from a task."
            action={
              <Button variant="primary" disabled={!api || creating} onClick={() => void newSession()}>
                <Plus size={13} />
                New session
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
