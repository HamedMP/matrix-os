import { AlertTriangle, RefreshCw, SquareTerminal } from "lucide-react";
import { useEffect } from "react";
import { Button, EmptyState, IconButton, StatusDot } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { categoryMessage } from "../../../../shared/app-error";

export default function SessionsView() {
  const api = useConnection((s) => s.api);
  const sessions = useSessions((s) => s.sessions);
  const loading = useSessions((s) => s.loading);
  const error = useSessions((s) => s.error);
  const load = useSessions((s) => s.load);
  const navigate = useUi((s) => s.navigate);

  useEffect(() => {
    if (api) void load(api);
  }, [api, load]);

  if (sessions.length === 0 && error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={28} />}
        headline="Could not load sessions"
        description={categoryMessage(error)}
        action={
          <Button
            variant="primary"
            onClick={() => {
              if (api) void load(api);
            }}
          >
            Refresh
          </Button>
        }
      />
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<SquareTerminal size={28} />}
        headline={loading ? "Loading sessions" : "No sessions"}
        description={
          loading
            ? "Checking terminal sessions on your computer."
            : "Terminal sessions running on your computer appear here."
        }
        action={
          <Button
            variant="primary"
            onClick={() => {
              if (api) void load(api);
            }}
          >
            Refresh
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-md font-semibold" style={{ color: "var(--text-primary)" }}>
          Sessions
        </h2>
        <IconButton
          label="Refresh"
          onClick={() => {
            if (api) void load(api);
          }}
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {sessions.map((session) => (
        <button
          key={session.attachName}
          type="button"
          className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-100"
          style={{ background: "var(--bg-raised)", borderColor: "var(--border-subtle)" }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-subtle)")}
          onClick={() => navigate({ kind: "session", sessionName: session.attachName })}
        >
          <StatusDot
            color={session.status === "active" ? "var(--status-complete)" : "var(--status-todo)"}
          />
          <span className="flex-1 truncate font-mono text-sm" style={{ color: "var(--text-primary)" }}>
            {session.name}
          </span>
          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            {session.status}
          </span>
        </button>
      ))}
    </div>
  );
}
