import { Plus, SquareTerminal, Trash2 } from "lucide-react";

import type { ShellSessionSummary } from "../../stores/shell-sessions";
import { OSWindowSafeView } from "../desktop-shell/OSWindow";
import { relativeSessionActivity } from "./terminal-session-activity";

function isActive(shell: ShellSessionSummary): boolean {
  return shell.status === "active" || shell.visualStatus === "running";
}

export function TerminalSessionSidebar({
  sessions,
  selectedName,
  creating,
  disabled,
  onCreate,
  onSelect,
  onDelete,
}: {
  sessions: ShellSessionSummary[];
  selectedName: string | null;
  creating: boolean;
  disabled: boolean;
  onCreate: () => void;
  onSelect: (session: ShellSessionSummary) => void;
  onDelete: (session: ShellSessionSummary) => void;
}) {
  return (
    <OSWindowSafeView
      area="sidebar"
      data-terminal-session-sidebar
      className="flex h-full min-h-0 w-full flex-col"
    >
      <aside className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--border-default, #F3F2F2)" }}>
        <div className="flex min-w-0 items-center gap-1">
          <SquareTerminal size={16} aria-hidden="true" />
          <h1 className="truncate text-base font-medium tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>Terminal</h1>
        </div>
        <button
          type="button"
          aria-label="New terminal session"
          disabled={disabled || creating}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-white disabled:opacity-50"
          style={{ background: "var(--surface-overlay, #242323)" }}
          onClick={onCreate}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      <ul aria-label="Terminal sessions" className="min-h-0 flex-1 overflow-y-auto pb-4">
        {sessions.map((session) => {
          const selected = selectedName === session.name;
          return (
            <li key={session.name} className="group/session relative shrink-0 border-b" style={{ borderColor: "var(--border-default, #F3F2F2)" }}>
              <button
                type="button"
                aria-label={`Open ${session.name}`}
                aria-current={selected || undefined}
                className="flex min-h-11 w-full min-w-0 items-center gap-1.5 px-4 py-3 pr-24 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                style={{ background: selected ? "var(--bg-hover)" : "transparent" }}
                onClick={() => onSelect(session)}
              >
                <span
                  data-terminal-session-status={isActive(session) ? "active" : "inactive"}
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: isActive(session) ? "var(--surface-success-emphasis, #288A5B)" : "var(--surface-tertiary, #E1E0E0)" }}
                />
                <span className="min-w-0 flex-1 truncate text-sm leading-5" style={{ color: "var(--text-primary)" }}>
                  {session.name}
                </span>
              </button>
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs transition-opacity group-hover/session:opacity-0" style={{ color: "var(--text-tertiary)" }}>
                {relativeSessionActivity(session.updatedAt)}
              </span>
              <button
                type="button"
                aria-label={`Delete ${session.name}`}
                className="absolute right-3 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-[var(--surface-base-background,#FFFFFD)] text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] group-hover/session:opacity-100"
                onClick={() => onDelete(session)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      </aside>
    </OSWindowSafeView>
  );
}
