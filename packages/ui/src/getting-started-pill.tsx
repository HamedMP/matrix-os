"use client";

import type { ComponentProps } from "react";
import { gettingStartedFraction as fraction } from "./getting-started-progress.js";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Top-bar trigger for the Getting started checklist, shared by Web Desktop and Electron Desktop. */
export function GettingStartedPill({ completed, total, className = "", ...props }: ComponentProps<"button"> & { completed: number; total: number }) {
  const offset = RING_CIRCUMFERENCE * (1 - fraction(completed, total));
  return (
    <button
      type="button"
      aria-label={`Getting started — ${completed} of ${total}`}
      title={`Getting started — ${completed} of ${total}`}
      {...props}
      className={`no-drag flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium tabular-nums outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50 ${className}`}
      style={{ color: "var(--text-primary, var(--foreground))", borderColor: "var(--border-subtle, var(--border))" }}
    >
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" className="shrink-0 -rotate-90">
        <circle cx="7" cy="7" r={RING_RADIUS} fill="none" strokeWidth="2" stroke="var(--border-subtle, var(--border))" />
        <circle data-progress cx="7" cy="7" r={RING_RADIUS} fill="none" strokeWidth="2" strokeLinecap="round"
          stroke="var(--accent, var(--primary))" strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={offset} />
      </svg>
      <span aria-hidden="true">Setup {completed}/{total}</span>
    </button>
  );
}

/** Body of the account menu's Getting started row; each renderer wraps it in its own menu item. */
export function GettingStartedMenuSummary({ completed, total, next }: { completed: number; total: number; next: string | null }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-center gap-2">
        <span className="flex-1 truncate">Getting started</span>
        <span className="text-[11px] tabular-nums opacity-70">{completed} of {total}</span>
      </span>
      <span role="progressbar" aria-label="Getting started progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}
        className="block h-1 w-full overflow-hidden rounded" style={{ background: "var(--border-subtle, var(--border))" }}>
        <span className="block h-full" style={{ width: `${fraction(completed, total) * 100}%`, background: "var(--accent, var(--primary))" }} />
      </span>
      {next ? <span className="truncate text-[11px] opacity-70">Next: {next}</span> : null}
    </span>
  );
}
