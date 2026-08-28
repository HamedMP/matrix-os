"use client";

import { PlusIcon, SearchIcon, SquareTerminalIcon } from "@/lib/hugeicons";

export function DesktopTerminalEmptyState({
  ready,
  onCreate,
}: {
  ready: boolean;
  onCreate: () => void;
}) {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col p-7"
      data-terminal-desktop-overview
      style={{ background: "var(--terminal-app-body-bg)", color: "var(--terminal-chrome-fg)" }}
    >
      <header className="flex shrink-0 items-center justify-between gap-4">
        <h1 className="font-serif text-[32px] leading-none tracking-[-0.035em]">Terminal</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Search shell sessions"
            className="flex size-9 items-center justify-center rounded-lg hover:bg-[var(--terminal-chrome-control-bg)]"
            style={{ color: "var(--terminal-chrome-muted)" }}
          >
            <SearchIcon className="size-4.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="New shell session"
            disabled={!ready}
            className="h-9 rounded-xl px-4 text-sm font-medium transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-50"
            style={{
              background: "var(--terminal-drawer-primary-button-bg)",
              color: "var(--terminal-drawer-primary-button-fg)",
            }}
            onClick={onCreate}
          >
            New
          </button>
        </div>
      </header>
      <div
        className="mt-7 flex min-h-[220px] flex-1 items-center justify-center rounded-xl border border-dashed"
        style={{ borderColor: "var(--terminal-chrome-border)" }}
      >
        <div className="flex flex-col items-center text-center">
          <SquareTerminalIcon className="size-6" style={{ color: "var(--terminal-chrome-muted)" }} aria-hidden="true" />
          <p className="mt-3 text-sm font-medium">No shell sessions yet</p>
          <p className="mt-1 text-xs" style={{ color: "var(--terminal-chrome-muted)" }}>Start a shell to attach from the Terminal app.</p>
          <button
            type="button"
            aria-label="New shell session"
            disabled={!ready}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl border px-4 text-sm font-medium disabled:opacity-50"
            style={{
              background: "var(--terminal-chrome-control-bg)",
              borderColor: "var(--terminal-chrome-control-border)",
              color: "var(--terminal-chrome-control-fg)",
            }}
            onClick={onCreate}
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            New shell
          </button>
        </div>
      </div>
    </section>
  );
}

export function DesktopTerminalSessionHeader({ title }: { title: string }) {
  return (
    <header
      data-testid="terminal-desktop-session-header"
      className="flex h-16 shrink-0 items-center justify-between border-b px-4"
      style={{
        background: "var(--terminal-app-body-bg)",
        borderColor: "var(--terminal-chrome-border)",
        color: "var(--terminal-chrome-fg)",
      }}
    >
      <div className="min-w-0">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <p className="mt-1 text-xs" style={{ color: "var(--terminal-chrome-muted)" }}>Connected to this Matrix OS runtime</p>
      </div>
      <span
        className="rounded-full border px-2.5 py-1 text-xs font-medium"
        style={{
          background: "var(--terminal-chrome-badge-bg)",
          borderColor: "var(--terminal-chrome-badge-border)",
          color: "var(--terminal-chrome-accent)",
        }}
      >
        Active
      </span>
    </header>
  );
}
