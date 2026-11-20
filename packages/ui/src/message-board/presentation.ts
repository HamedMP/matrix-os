import type { CSSProperties } from "react";
import {
  AlertCircleIcon, CancelCircleIcon, CheckmarkCircle02Icon, CircleIcon, DashedLineCircleIcon, HourglassIcon, Loading03Icon,
} from "@hugeicons/core-free-icons";
import { MessageBoardError, type MessageBoardErrorReason } from "./client.js";
import type { BoardTaskState } from "./types.js";

export const textPrimary: CSSProperties = { color: "var(--text-primary, var(--foreground))" };
export const textSecondary: CSSProperties = { color: "var(--text-secondary, var(--muted-foreground))" };
export const textTertiary: CSSProperties = { color: "var(--text-tertiary, var(--muted-foreground))" };
export const subtleBorder: CSSProperties = { borderColor: "var(--border-subtle, var(--border))" };
export const sunkenFill: CSSProperties = { background: "var(--bg-sunken, var(--muted))" };
export const surfaceFill: CSSProperties = { background: "var(--bg-surface, var(--card))" };

const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))]";
const hover = "hover:bg-[var(--bg-hover,rgba(0,0,0,0.05))]";

export const chipClass = `inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] ${focusRing} ${hover} aria-pressed:bg-[var(--bg-selected,var(--bg-hover))] aria-pressed:font-medium disabled:cursor-not-allowed disabled:opacity-50`;
export const iconButtonClass = `inline-grid size-7 shrink-0 place-items-center rounded-lg ${focusRing} ${hover}`;
export const actionButtonClass = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] border px-3 text-[13px] font-medium ${focusRing} ${hover} disabled:cursor-not-allowed disabled:opacity-50`;
export const primaryButtonClass = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium ${focusRing} hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50`;
export const primaryButtonStyle: CSSProperties = { background: "var(--primary)", color: "var(--primary-foreground)" };
export const rowClass = `w-full rounded-lg text-left ${focusRing} ${hover} aria-[current=true]:bg-[var(--bg-selected,var(--bg-hover))]`;
export const fieldClass = "min-w-0 rounded-[10px] border bg-transparent px-2.5 text-[13px] outline-none focus:border-[var(--text-primary,currentColor)]";
export const sectionLabelClass = "px-2 pb-1 pt-3 text-xs font-medium";

const neutral: CSSProperties = { border: "1px solid var(--border-subtle, var(--border))", ...textTertiary };

export const TASK_STATE_STYLE: Readonly<Record<BoardTaskState, CSSProperties>> = {
  ready: { background: "var(--success-muted)", color: "var(--success-text)" },
  claimed: { background: "var(--info-muted)", color: "var(--info-text)" },
  blocked: { background: "var(--warning-muted)", color: "var(--warning-text)" },
  waiting: neutral,
  failed: { background: "var(--danger-muted)", color: "var(--danger-text)" },
  completed: { border: "1px solid var(--border-subtle, var(--border))", color: "var(--success-text)" },
  canceled: neutral,
};

export const TASK_STATE_ICON = {
  ready: CircleIcon,
  claimed: Loading03Icon,
  blocked: AlertCircleIcon,
  waiting: HourglassIcon,
  failed: CancelCircleIcon,
  completed: CheckmarkCircle02Icon,
  canceled: DashedLineCircleIcon,
} as const satisfies Record<BoardTaskState, unknown>;

const ERROR_COPY: Partial<Record<MessageBoardErrorReason, string>> = {
  task_claimed: "Someone else holds this task now.",
  task_assigned: "This task is assigned to a profile. Return it to the pool to claim it yourself.",
  claim_not_held: "You no longer hold this claim.",
  claim_lost: "You no longer hold this claim.",
  task_waiting: "This task is waiting on another task.",
  task_blocked: "This task is blocked.",
  task_finished: "This task is already finished.",
  revision_conflict: "This message changed since you opened it. Close the editor and try again.",
  reserved_label: "Labels starting with board. or matrix. are set by Matrix OS.",
  message_deleted: "This message was deleted.",
  forbidden: "You can only change your own messages.",
  invalid_input: "Check what you entered and try again.",
  duplicate_id: "This thread is already a task.",
  not_found: "This item no longer exists.",
  unavailable: "The board is not reachable right now. Try again.",
};

/** Allowlisted copy only; unknown or raw errors never reach the screen. */
export function messageBoardErrorCopy(error: unknown): string {
  if (error instanceof MessageBoardError) return ERROR_COPY[error.reason] ?? "Something went wrong. Try again.";
  return "Something went wrong. Try again.";
}

export function formatBoardTime(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((nowMs - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatUntil(iso: string, nowMs: number): string {
  const minutes = Math.round((Date.parse(iso) - nowMs) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}
