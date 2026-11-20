"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { POPOVER_LAYER } from "../layering.js";
import { ChatComposerSelect } from "../chat/composer/ChatComposerSelect.js";
import type { MessageBoardClient } from "./client.js";
import { actorLabel, availableTaskActions, formatLeaseCountdown, type PersonTaskAction } from "./model.js";
import { subtleBorder, textPrimary, textSecondary, textTertiary } from "./presentation.js";
import { BoardMarkdown } from "./BoardMarkdown.js";
import { TaskStateChip } from "./TaskStateChip.js";
import type { BoardTask, BoardTaskNeed } from "./types.js";
import type { MutationResult } from "./use-message-board.js";
import { BoardButton, BoardInput } from "./controls.js";

const ACTION_LABEL: Record<PersonTaskAction, string> = {
  claim: "Claim", complete: "Complete", release: "Release", assign: "Assign", block: "Block",
  unblock: "Unblock", reopen: "Reopen", cancel: "Cancel task",
};
/** Actions that need a reason or a choice before they run. */
type FormAction = "complete" | "assign" | "block" | "cancel";
const POOL = "__pool__";

export interface TaskPanelProps {
  taskId: string;
  task: BoardTask;
  needs: readonly BoardTaskNeed[];
  viewerId: string;
  profiles: readonly string[];
  nowMs: number;
  mutate(work: (client: MessageBoardClient, board: string) => Promise<unknown>): Promise<MutationResult>;
  onOpenThread(id: string): void;
}

/** Task state, holder and lease, prerequisites, outcome, and the actions a person may take. */
export function TaskPanel({ taskId, task, needs, viewerId, profiles, nowMs, mutate, onOpenThread }: TaskPanelProps) {
  const [form, setForm] = useState<FormAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lease = task.state === "claimed" ? formatLeaseCountdown(task.leaseUntil, nowMs) : null;
  const actions = availableTaskActions(task, viewerId);

  const run = async (work: (client: MessageBoardClient, board: string) => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      const result = await mutate(work);
      if (result.ok) setForm(null);
      else setError(result.error);
    } finally {
      setPending(false);
    }
  };

  const direct: Partial<Record<PersonTaskAction, () => void>> = {
    claim: () => void run((client, board) => client.claimTask(board, taskId)),
    release: () => void run((client, board) => client.releaseTask(board, taskId)),
    unblock: () => void run((client, board) => client.unblockTask(board, taskId)),
    reopen: () => void run((client, board) => client.reopenTask(board, taskId)),
  };

  return <section aria-label="Board task" className="mx-3 mb-2 rounded-[14px] border px-3 py-2.5" style={{ ...subtleBorder, background: "var(--bg-sunken, var(--muted))" }}
    onKeyDown={(event) => { if (event.key === "Escape" && form) { event.stopPropagation(); setForm(null); } }}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      <TaskStateChip state={task.state} size="md" />
      {task.holder && task.state === "claimed" ? <span style={textSecondary}>held by <span className="font-medium" style={textPrimary}>{actorLabel(task.holder, viewerId)}</span></span> : null}
      {lease ? <span className="inline-flex items-center gap-1 font-mono text-xs" style={lease === "expired" ? { color: "var(--danger-text)" } : textSecondary}
        aria-label={lease === "expired" ? "Lease expired" : `Lease ends in ${lease}`}>
        <HugeiconsIcon icon={Clock01Icon} size={12} aria-hidden /> {lease === "expired" ? "lease expired" : `lease ${lease}`}
      </span> : null}
      <span className="text-xs" style={textTertiary}>{task.assignedProfile ? `for ${task.assignedProfile}` : "open to any agent"}</span>
    </div>
    {task.state === "blocked" && task.blockedReason ? <Outcome label={task.blockedKind ? `Blocked · ${task.blockedKind}` : "Blocked"} text={task.blockedReason} tone="warning" /> : null}
    {task.state === "failed" && task.failureReason ? <Outcome label="Failed" text={task.failureReason} tone="danger" /> : null}
    {task.state === "canceled" && task.cancelReason ? <Outcome label="Canceled" text={task.cancelReason} tone="neutral" /> : null}
    {task.state === "completed" && task.result ? <Outcome label="Result" text={task.result} tone="success" /> : null}
    {needs.length > 0 ? <div className="mt-2 text-xs" style={textSecondary}>
      <span style={textTertiary}>Needs </span>
      {needs.map((need, index) => <span key={need.id}>
        {index > 0 ? ", " : null}
        <BoardButton look="plain" className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))]" style={textPrimary}
          onClick={() => onOpenThread(need.id)}>{need.title}</BoardButton> <TaskStateChip state={need.state} />
      </span>)}
    </div> : null}
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {actions.map((action) => {
        const primary = action === "claim" || action === "complete" || action === "unblock" || action === "reopen";
        const onClick = direct[action] ?? (() => setForm(action as FormAction));
        return <BoardButton key={action} type="button" disabled={pending} aria-expanded={action in direct ? undefined : form === action}
          look={primary ? "primary" : "action"} style={primary ? undefined : { ...subtleBorder, ...(action === "cancel" ? { color: "var(--danger-text)" } : textPrimary) }}
          onClick={onClick}>{ACTION_LABEL[action]}</BoardButton>;
      })}
    </div>
    {form ? <TaskForm key={form} action={form} profiles={profiles} current={task.assignedProfile} pending={pending}
      onCancel={() => setForm(null)}
      onSubmit={(value, kind) => {
        if (form === "complete") void run((client, board) => client.completeTask(board, taskId, value || undefined));
        if (form === "block") void run((client, board) => client.blockTask(board, taskId, value, kind || undefined));
        if (form === "cancel") void run((client, board) => client.cancelTask(board, taskId, value));
        if (form === "assign") void run((client, board) => client.assignTask(board, taskId, value === POOL ? null : value));
      }} /> : null}
    {error ? <p role="alert" className="pt-2 text-xs" style={{ color: "var(--danger-text)" }}>{error}</p> : null}
  </section>;
}

function Outcome({ label, text, tone }: { label: string; text: string; tone: "warning" | "danger" | "success" | "neutral" }) {
  const color = tone === "neutral" ? "var(--text-tertiary)" : `var(--${tone}-text)`;
  return <div className="mt-2 rounded-lg px-2.5 py-1.5" style={{ background: "var(--bg-surface, var(--card))" }}>
    <p className="text-[11px] font-semibold" style={{ color }}>{label}</p>
    <BoardMarkdown text={text} />
  </div>;
}

function TaskForm({ action, profiles, current, pending, onSubmit, onCancel }: {
  action: FormAction; profiles: readonly string[]; current: string | null; pending: boolean;
  onSubmit(value: string, kind: string): void; onCancel(): void;
}) {
  const [value, setValue] = useState(action === "assign" ? current ?? POOL : "");
  const [kind, setKind] = useState("needs_input");
  const needsReason = action === "block" || action === "cancel";
  const copy = {
    complete: { label: "Result (optional)", placeholder: "Merged the fix in #3501", submit: "Complete" },
    block: { label: "Why is it blocked?", placeholder: "Needs a decision on…", submit: "Block" },
    cancel: { label: "Why cancel it?", placeholder: "Duplicate of…", submit: "Cancel task" },
    assign: { label: "Who may claim it?", placeholder: "", submit: "Assign" },
  }[action];
  return <form className="mt-2.5 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); onSubmit(value.trim(), kind.trim()); }}>
    {action === "assign"
      ? <div className="flex items-center gap-2 text-[13px]">
          <span style={textSecondary}>{copy.label}</span>
          <ChatComposerSelect label="Assign to profile" value={value} menuSide="bottom" menuZIndex={POPOVER_LAYER} onChange={setValue}
            options={[{ value: POOL, label: "Anyone (pool)" }, ...profiles.map((profile) => ({ value: profile, label: profile }))]} />
        </div>
      : <label className="flex flex-col gap-1 text-xs" style={textSecondary}>
          {copy.label}
          <BoardInput autoFocus value={value} maxLength={500} placeholder={copy.placeholder} onChange={(event) => setValue(event.currentTarget.value)} />
        </label>}
    {action === "block" ? <label className="flex flex-col gap-1 text-xs" style={textSecondary}>
      Kind
      <BoardInput value={kind} maxLength={48} onChange={(event) => setKind(event.currentTarget.value)} style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }} />
    </label> : null}
    <div className="flex justify-end gap-1.5">
      <BoardButton look="action" style={{ ...subtleBorder, ...textSecondary }} onClick={onCancel}>Back</BoardButton>
      <BoardButton look="primary" type="submit" disabled={pending || (needsReason && value.trim().length === 0)}>{copy.submit}</BoardButton>
    </div>
  </form>;
}
