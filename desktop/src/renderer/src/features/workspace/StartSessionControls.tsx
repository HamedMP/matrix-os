import { Bot, SquareTerminal, Sparkles } from "lucide-react";
import { useState } from "react";
import { toUserMessage } from "../../lib/errors";
import { startTaskSession } from "../../lib/task-sessions";
import { useConnection } from "../../stores/connection";
import { useSessions } from "../../stores/sessions";

type Launch =
  | { kind: "shell"; label: string }
  | { kind: "agent"; agent: "claude" | "codex"; label: string };

const LAUNCHERS: Launch[] = [
  { kind: "shell", label: "Shell" },
  { kind: "agent", agent: "claude", label: "Claude" },
  { kind: "agent", agent: "codex", label: "Codex" },
];

function glyph(l: Launch) {
  if (l.kind === "shell") return <SquareTerminal size={13} />;
  return l.agent === "claude" ? <Sparkles size={13} /> : <Bot size={13} />;
}

/**
 * Launches a cloud terminal/agent session bound to a task: POST /api/sessions
 * (with the task + worktree + an agent prompt prefilled from the task) then
 * links the new session back onto the task and flips it to "running". The task
 * workspace re-derives its attach target and the terminal panel attaches.
 */
export default function StartSessionControls({
  projectSlug,
  taskId,
  worktreeId,
  title,
  description,
  compact = false,
}: {
  projectSlug: string;
  taskId: string;
  worktreeId: string | null;
  title: string;
  description: string;
  compact?: boolean;
}) {
  const api = useConnection((s) => s.api);
  const creating = useSessions((s) => s.creating);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const launch = async (l: Launch) => {
    if (!api || pending) return;
    setPending(l.label);
    setError(null);
    try {
      const ok = await startTaskSession(api, {
        projectSlug,
        taskId,
        worktreeId,
        title,
        description,
        kind: l.kind,
        ...(l.kind === "agent" ? { agent: l.agent } : {}),
      });
      if (!ok) setError("Couldn't start the session. Check that the agent is connected.");
    } catch (err: unknown) {
      setError(toUserMessage(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={compact ? "flex items-center gap-1.5" : "flex flex-col items-center gap-2"}>
      <div className="flex items-center gap-1.5">
        {LAUNCHERS.map((l) => (
          <button
            key={l.label}
            type="button"
            disabled={creating || pending !== null}
            onClick={() => void launch(l)}
            className="no-drag flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors duration-100 disabled:opacity-50"
            style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)", color: "var(--text-primary)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-surface)")}
          >
            {glyph(l)}
            {pending === l.label ? "Starting…" : l.label}
          </button>
        ))}
      </div>
      {error && !compact ? (
        <span className="text-xs" style={{ color: "var(--danger)" }}>{error}</span>
      ) : null}
    </div>
  );
}
