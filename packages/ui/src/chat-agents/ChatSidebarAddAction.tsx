import type { MouseEventHandler } from "react";

/** Shared geometry for the sidebar's Agent and Project creation actions. */
export function ChatSidebarAddAction({ label, ariaLabel, onClick }: {
  label: string;
  ariaLabel: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  return <button type="button" aria-label={ariaLabel}
    className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent,var(--matrix-accent,var(--matrix-ring))))]"
    style={{ color: "var(--text-tertiary, var(--matrix-muted-fg, var(--muted-foreground)))" }} onClick={onClick}>
    <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M8 2v12M2 8h12" />
      </svg>
    </span>
    <span>{label}</span>
  </button>;
}
