"use client";

import { PlusIcon, SquareTerminalIcon, Trash2Icon } from "@/lib/hugeicons";
import type { ShellSessionSummary } from "./terminal-session-state";
import { ThemePickerButton } from "./TerminalThemePicker";

export function DesktopTerminalSidebar({
  sessions,
  selectedName,
  creating,
  onCreate,
  onOpen,
  onDelete,
}: {
  sessions: ShellSessionSummary[];
  selectedName: string | null;
  creating: boolean;
  onCreate: () => void;
  onOpen: (shell: ShellSessionSummary) => void;
  onDelete: (shell: ShellSessionSummary, anchor: HTMLButtonElement) => void;
}) {
  return (
    <aside
      data-testid="terminal-sidebar-shell"
      data-terminal-sidebar-shell
      data-terminal-sidebar-variant="desktop"
      className="flex h-full w-[280px] min-w-[200px] max-w-[280px] shrink-0 flex-col overflow-hidden border-r"
      style={{
        background: "var(--terminal-drawer-bg)",
        borderColor: "var(--terminal-drawer-border)",
        color: "var(--terminal-drawer-fg)",
      }}
    >
      <header
        className="flex h-12 shrink-0 items-center justify-between border-b px-4"
        style={{ borderColor: "var(--terminal-drawer-border)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminalIcon className="size-4 shrink-0" aria-hidden="true" />
          <h1 className="truncate text-sm font-medium tracking-[-0.02em]">Terminal</h1>
        </div>
        <button
          type="button"
          aria-label="New shell session"
          disabled={creating}
          className="flex size-7 items-center justify-center rounded-lg transition-transform hover:scale-[1.03] active:scale-95 disabled:opacity-50"
          style={{
            background: "var(--terminal-drawer-primary-button-bg)",
            color: "var(--terminal-drawer-primary-button-fg)",
          }}
          onClick={onCreate}
        >
          <PlusIcon className="size-4" aria-hidden="true" />
        </button>
      </header>

      <ul aria-label="Terminal sessions" className="min-h-0 flex-1 overflow-y-auto">
        {sessions.map((shell) => {
          const selected = selectedName === shell.name;
          const active = shell.status === "active" || shell.visualStatus === "running";
          return (
            <li
              key={shell.name}
              className="group relative border-b"
              style={{ borderColor: "var(--terminal-drawer-border)" }}
            >
              <button
                type="button"
                aria-label={`Open ${shell.name}`}
                aria-current={selected || undefined}
                data-session-name={shell.name}
                className="flex min-h-12 w-full items-center gap-2 px-4 pr-12 text-left transition-colors hover:bg-[var(--terminal-drawer-card-bg)]"
                style={{ background: selected ? "var(--terminal-drawer-card-selected-bg)" : "transparent" }}
                onClick={() => onOpen(shell)}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: active ? "var(--terminal-drawer-selected-stripe)" : "var(--terminal-drawer-muted)" }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{shell.subtitle?.trim() || shell.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${shell.name}`}
                className="absolute right-3 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-[var(--terminal-drawer-action-bg)] focus-visible:opacity-100 group-hover:opacity-100"
                style={{ color: "var(--terminal-drawer-destructive-fg)" }}
                onClick={(event) => onDelete(shell, event.currentTarget)}
              >
                <Trash2Icon className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>

      <footer
        className="shrink-0 border-t p-3"
        style={{ borderColor: "var(--terminal-drawer-border)" }}
      >
        <ThemePickerButton mobile={false} menuPlacement="above-start" />
      </footer>
    </aside>
  );
}
