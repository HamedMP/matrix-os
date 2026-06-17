import { Plus, RefreshCw, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, EmptyState, IconButton, StatusDot } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useSessions } from "../../stores/sessions";
import TerminalView from "./TerminalView";

// The Terminal workspace: an inner sidebar listing every VPS session, with the
// selected one attached on the right. Mirrors the shell's terminal app.
export default function TerminalsTab() {
  const api = useConnection((s) => s.api);
  const sessions = useSessions((s) => s.sessions);
  const load = useSessions((s) => s.load);
  const create = useSessions((s) => s.create);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="flex w-[220px] shrink-0 flex-col border-r"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Sessions</span>
          <IconButton label="Refresh sessions" onClick={() => api && void load(api)}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {sessions.length === 0 ? (
            <p className="px-2.5 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>No sessions on your computer yet.</p>
          ) : (
            sessions.map((s) => {
              const active = s.attachName === selected;
              return (
                <button
                  key={s.attachName}
                  type="button"
                  className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100"
                  style={{ background: active ? "var(--bg-selected)" : "transparent" }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                  onClick={() => setSelected(s.attachName)}
                >
                  <StatusDot color={s.status === "active" ? "var(--status-complete)" : "var(--status-todo)"} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" style={{ color: "var(--text-primary)" }}>{s.name}</span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t p-2" style={{ borderColor: "var(--border-subtle)" }}>
          <Button
            variant="subtle"
            className="w-full justify-center"
            disabled={!api || creating}
            onClick={() => {
              if (!api || creating) return;
              setCreating(true);
              void create(api)
                .then((session) => {
                  if (session) setSelected(session.attachName);
                })
                .finally(() => setCreating(false));
            }}
          >
            <Plus size={13} />
            {creating ? "Creating…" : "New session"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <TerminalView key={selected} sessionName={selected} active />
        ) : (
          <EmptyState
            icon={<SquareTerminal size={26} />}
            headline="No session selected"
            description="Pick a session on the left, or open one from a project."
          />
        )}
      </div>
    </div>
  );
}
