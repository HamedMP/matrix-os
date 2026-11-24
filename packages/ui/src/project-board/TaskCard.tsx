"use client";

import { GitBranch, Link2, MessageSquare, ListTree, Ban } from "lucide-react";
import type { CSSProperties, KeyboardEvent, Ref } from "react";
import { rollUpTaskAgentStatus } from "./board-model.js";
import { formatDue } from "./board-format.js";
import { ActorAvatar, AgentStatusBadge, LabelChip, PriorityIcon, PullRequestBadge } from "./board-primitives.js";
import { tone } from "./board-style.js";
import type { BoardMember, ProjectTask } from "./types.js";

const MAX_CARD_LABELS = 3;

export interface TaskCardProps {
  task: ProjectTask;
  members: readonly BoardMember[];
  nowMs: number;
  /** Open subtasks under this card. */
  subtaskCount?: number;
  /** Blockers that are not done yet. */
  openBlockerCount?: number;
  onOpen?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  /** The floating copy under the pointer while dragging. */
  overlay?: boolean;
  /** The card's own slot while it is being dragged. */
  placeholder?: boolean;
  cardRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  dragHandleProps?: Record<string, unknown>;
  describedBy?: string;
}

/** One board card: key, title and the facts a person scans for, laid out the same in every column. */
export function TaskCard({
  task, members, nowMs, subtaskCount = 0, openBlockerCount = 0, onOpen, onKeyDown, overlay, placeholder, cardRef, style, dragHandleProps, describedBy,
}: TaskCardProps) {
  const agent = rollUpTaskAgentStatus(task);
  const key = task.key;
  const labels = task.labels.slice(0, MAX_CARD_LABELS);
  const hiddenLabels = task.labels.length - labels.length;
  const due = task.dueAt && task.status !== "done" && task.status !== "canceled" ? formatDue(task.dueAt, nowMs) : null;
  const facts = [task.priority !== "none" ? task.priority : null, agent ? `agent ${agent}` : null, task.pullRequest ? `pull request ${task.pullRequest.state}` : null]
    .filter(Boolean).join(", ");
  return <div ref={cardRef} style={{
    ...style, borderColor: "var(--border-subtle, var(--border))", background: "var(--bg-surface, var(--card))",
    opacity: placeholder ? 0.4 : undefined, boxShadow: overlay ? "0 10px 28px rgba(0,0,0,0.16)" : undefined,
  }}
    data-task-id={task.id} data-agent-status={agent}
    className={`group relative rounded-[12px] border text-left transition-colors ${overlay ? "rotate-[1.5deg] cursor-grabbing" : "hover:border-[var(--border-default,var(--border))]"}`}>
    <div role="button" tabIndex={0} aria-label={`${key}: ${task.title}${facts ? ` (${facts})` : ""}`} aria-describedby={describedBy}
      aria-roledescription="draggable task card"
      onClick={onOpen} onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen?.(); }
      }}
      {...dragHandleProps}
      className="block w-full cursor-pointer rounded-[12px] p-2.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent))] active:cursor-grabbing">
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium" style={tone.muted}>
        <PriorityIcon priority={task.priority} size={13} />
        <span className="shrink-0 whitespace-nowrap font-mono tracking-tight">{key}</span>
        {task.externalLink ? <span className="inline-flex min-w-0 items-center gap-0.5 overflow-hidden whitespace-nowrap font-mono" title={`Linked to Linear ${task.externalLink.key}`}>
          <Link2 size={10} aria-hidden className="shrink-0" /><span className="truncate">{task.externalLink.key}</span>
        </span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {agent && agent !== "idle" ? <AgentStatusBadge status={agent} /> : null}
          <ActorAvatar members={members} actor={task.assignee} size={18} />
        </span>
      </div>
      <p className="mt-1.5 line-clamp-3 break-words text-[13.5px] font-medium leading-[18px]" style={tone.primary}>{task.title}</p>
      {labels.length > 0 ? <div className="mt-2 flex flex-wrap gap-1">
        {labels.map((label) => <LabelChip key={label} name={label} />)}
        {hiddenLabels > 0 ? <span className="inline-flex h-5 items-center px-1 text-[11px]" style={tone.muted} title={task.labels.slice(MAX_CARD_LABELS).join(", ")}>+{hiddenLabels}</span> : null}
      </div> : null}
      <CardFooter task={task} subtaskCount={subtaskCount} openBlockerCount={openBlockerCount} due={due} />
    </div>
  </div>;
}

function CardFooter({ task, subtaskCount, openBlockerCount, due }: {
  task: ProjectTask; subtaskCount: number; openBlockerCount: number; due: { label: string; overdue: boolean } | null;
}) {
  const hasFooter = task.branch || task.pullRequest || task.commentCount > 0 || subtaskCount > 0 || openBlockerCount > 0 || due;
  if (!hasFooter) return null;
  return <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]" style={tone.muted}>
    {task.pullRequest ? <PullRequestBadge pr={task.pullRequest} /> : null}
    {task.branch && !task.pullRequest ? <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono" title={task.branch}>
      <GitBranch size={11} aria-hidden className="shrink-0" /><span className="truncate">{task.branch}</span>
    </span> : null}
    {openBlockerCount > 0 ? <span className="inline-flex items-center gap-1" style={{ color: "var(--warning-text, var(--warning))" }} title="Blocked by other tasks">
      <Ban size={11} aria-hidden />Blocked{openBlockerCount > 1 ? ` by ${openBlockerCount}` : ""}
    </span> : null}
    {subtaskCount > 0 ? <span className="inline-flex items-center gap-1" title={`${subtaskCount} subtasks`}><ListTree size={11} aria-hidden />{subtaskCount}</span> : null}
    {due ? <span style={due.overdue ? { color: "var(--destructive-text, var(--destructive))" } : undefined}>{due.label}</span> : null}
    {task.commentCount > 0 ? <span className="ml-auto inline-flex items-center gap-1" title={`${task.commentCount} comments`}>
      <MessageSquare size={11} aria-hidden />{task.commentCount}
    </span> : null}
  </div>;
}
