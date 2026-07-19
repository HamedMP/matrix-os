import { ChevronLeft, Play, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { RuntimeSummary, TerminalSessionSummary } from "@matrix-os/contracts";
import { IconButton } from "../../design/primitives";
import TerminalView from "../terminal/TerminalView";

const STATUS_COLOR: Record<string, string> = {
  running: "var(--success)",
  idle: "var(--text-tertiary)",
  starting: "var(--warning)",
  exited: "var(--text-tertiary)",
  stale: "var(--warning)",
  unavailable: "var(--danger)",
};

/**
 * Inspector Terminal surface: a session list as the entry state; picking an
 * attachable session embeds the shared xterm TerminalView inline (one at a
 * time) with a back-to-list affordance. `active` gates the live socket — the
 * owner passes false while this inspector tab is hidden so the single
 * app-wide terminal attachment is released (attach-manager lesson L4).
 */
export function InspectorTerminalPanel({
  summary,
  active = true,
}: {
  summary: RuntimeSummary;
  active?: boolean;
}) {
  const [embeddedId, setEmbeddedId] = useState<string | null>(null);
  const sessions = summary.terminalSessions.items;
  // The embedded session must still exist and stay attachable; a refresh that
  // ends or detaches it drops the embed back to the list in the same render.
  const embedded = embeddedId
    ? sessions.find((candidate) => candidate.id === embeddedId && candidate.attachable) ?? null
    : null;

  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 items-center gap-2">
          <IconButton label="Back to terminal sessions" onClick={() => setEmbeddedId(null)}>
            <ChevronLeft size={14} />
          </IconButton>
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: STATUS_COLOR[embedded.status] ?? "var(--text-tertiary)" }}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {embedded.name}
          </span>
          <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
            {embedded.status}
          </span>
        </div>
        <div
          className="flex min-h-[240px] min-w-0 flex-1 flex-col overflow-hidden rounded-md border"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <TerminalView key={embedded.name} sessionName={embedded.name} active={active} />
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {sessions.map((session) => (
        <SessionRow key={session.id} session={session} onOpen={() => setEmbeddedId(session.id)} />
      ))}
      {sessions.length === 0 ? (
        <p
          className="rounded-md border p-3 text-sm"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          No terminal sessions.
        </p>
      ) : null}
    </div>
  );
}

function SessionRow({
  session,
  onOpen,
}: {
  session: TerminalSessionSummary;
  onOpen: () => void;
}) {
  return (
    <article
      className="flex items-center justify-between gap-3 rounded-md border p-3"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SquareTerminal size={15} style={{ color: "var(--text-tertiary)" }} />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {session.name}
          </h3>
          <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            {session.attachable ? "Attachable" : "Unavailable"}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs capitalize" style={{ color: "var(--text-secondary)" }}>
          {session.status}
        </span>
        {session.attachable ? (
          <IconButton label={`Open terminal ${session.name}`} onClick={onOpen}>
            <Play size={13} />
          </IconButton>
        ) : null}
      </div>
    </article>
  );
}
