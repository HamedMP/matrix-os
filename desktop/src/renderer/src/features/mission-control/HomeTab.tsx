import { Kanban, Plus, RefreshCw, Sparkles, SquareTerminal } from "lucide-react";
import { useEffect } from "react";
import { Button, IconButton } from "../../design/primitives";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useSessions } from "../../stores/sessions";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border p-4"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)", boxShadow: "var(--shadow-1)" }}
    >
      {children}
    </div>
  );
}

export default function HomeTab() {
  const api = useConnection((s) => s.api);
  const handle = useConnection((s) => s.handle);
  const projects = useBoard((s) => s.projects);
  const sessions = useSessions((s) => s.sessions);
  const sessionsLoading = useSessions((s) => s.loading);
  const sessionsError = useSessions((s) => s.error);
  const loadSessions = useSessions((s) => s.load);
  const openTab = useTabs((s) => s.openTab);
  const setComposerOpen = useUi((s) => s.setComposerOpen);

  useEffect(() => {
    if (api) void loadSessions(api);
  }, [api, loadSessions]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[920px] px-8 py-10">
        <div className="mb-8 flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: "var(--text-primary)", fontSize: "var(--text-2xl)" }}>
            {handle ? `Welcome back, @${handle}` : "Welcome to Matrix OS"}
          </h1>
          <p className="text-md" style={{ color: "var(--text-secondary)" }}>
            Your cloud computer is ready. Pick up a project, attach a terminal, or start an agent.
          </p>
        </div>

        <div className="mb-6 flex gap-3">
          <Button variant="primary" onClick={() => setComposerOpen(true)}>
            <Sparkles size={14} />
            Start an agent
          </Button>
          {projects[0] ? (
            <Button
              variant="subtle"
              onClick={() => openTab({ kind: "board", projectSlug: projects[0]!.slug, title: projects[0]!.name || projects[0]!.slug })}
            >
              <Kanban size={14} />
              Open board
            </Button>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                <Kanban size={15} style={{ color: "var(--accent)" }} /> Projects
              </h2>
            </div>
            <div className="flex flex-col gap-0.5">
              {projects.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>No projects yet.</p>
              ) : (
                projects.slice(0, 6).map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() => openTab({ kind: "board", projectSlug: p.slug, title: p.name || p.slug })}
                  >
                    <span style={{ color: "var(--text-tertiary)" }}>▣</span>
                    <span className="truncate" style={{ color: "var(--text-primary)" }}>{p.name || p.slug}</span>
                  </button>
                ))
              )}
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                <SquareTerminal size={15} style={{ color: "var(--accent)" }} /> Sessions
              </h2>
              <IconButton label="Refresh sessions" onClick={() => api && void loadSessions(api)}>
                <RefreshCw size={13} />
              </IconButton>
            </div>
            <div className="flex flex-col gap-0.5">
              {sessionsLoading && sessions.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>Loading sessions…</p>
              ) : sessionsError ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm" style={{ color: "var(--danger)" }}>Sessions unavailable.</p>
                  <Button variant="subtle" onClick={() => api && void loadSessions(api)}>
                    <RefreshCw size={13} />
                    Retry sessions
                  </Button>
                </div>
              ) : sessions.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>No live sessions.</p>
              ) : (
                sessions.slice(0, 8).map((s) => (
                  <button
                    key={s.attachName}
                    type="button"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
                    onClick={() => openTab({ kind: "terminal", sessionName: s.attachName, title: s.name })}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: s.status === "active" ? "var(--status-complete)" : "var(--status-todo)" }}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" style={{ color: "var(--text-primary)" }}>{s.name}</span>
                    <Plus size={12} style={{ color: "var(--text-tertiary)" }} />
                  </button>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
