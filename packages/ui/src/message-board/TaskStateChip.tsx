import { HugeiconsIcon } from "@hugeicons/react";
import { TASK_STATE_LABELS } from "./model.js";
import { TASK_STATE_ICON, TASK_STATE_STYLE } from "./presentation.js";
import { BoardButton } from "./controls.js";
import type { BoardTaskState } from "./types.js";

/** Task state as icon plus word, so state is never carried by color alone. */
export function TaskStateChip({ state, size = "sm" }: { state: BoardTaskState; size?: "sm" | "md" }) {
  return <span data-task-state={state}
    className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-semibold ${size === "md" ? "px-2 py-0.5 text-xs" : "px-1.5 py-px text-[11px]"}`}
    style={TASK_STATE_STYLE[state]}>
    <HugeiconsIcon icon={TASK_STATE_ICON[state]} size={size === "md" ? 12 : 11} strokeWidth={2} aria-hidden />
    {TASK_STATE_LABELS[state]}
  </span>;
}

export function LabelChip({ name, value, onRemove }: { name: string; value: string; onRemove?: () => void }) {
  return <span className="inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[11px]"
    style={{ borderColor: "var(--border-subtle, var(--border))", color: "var(--text-secondary, var(--muted-foreground))" }}>
    <span className="truncate">{name}={value}</span>
    {onRemove ? <BoardButton look="plain" aria-label={`Remove label ${name}`} onClick={onRemove}
      className="-mr-0.5 rounded px-0.5 leading-none outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))]">×</BoardButton> : null}
  </span>;
}
