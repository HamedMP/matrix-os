"use client";

import type { CSSProperties, ReactNode } from "react";
import { Bot, Check, Clock3, GitMerge, GitPullRequest, GitPullRequestDraft, X } from "lucide-react";
import { actorName, memberFor, pullRequestDescription } from "./board-format.js";
import { focusRing, tone } from "./board-style.js";
import {
  TASK_PRIORITY_LABEL, TASK_STATUS_LABEL,
  type ActorRef, type BoardMember, type TaskAgentStatus, type TaskPriority, type TaskPullRequest, type TaskStatus,
} from "./types.js";

type Semantic = "success" | "warning" | "danger" | "info" | "neutral";

const SEMANTIC: Record<Semantic, { fill: string; text: string }> = {
  success: { fill: "var(--success)", text: "var(--success-text, var(--success))" },
  warning: { fill: "var(--warning)", text: "var(--warning-text, var(--warning))" },
  danger: { fill: "var(--destructive)", text: "var(--destructive-text, var(--destructive))" },
  info: { fill: "var(--info, var(--muted-foreground))", text: "var(--info-text, var(--muted-foreground))" },
  neutral: { fill: "var(--text-tertiary, var(--muted-foreground))", text: "var(--text-secondary, var(--muted-foreground))" },
};

function tinted(semantic: Semantic): CSSProperties {
  const { fill, text } = SEMANTIC[semantic];
  return semantic === "neutral"
    ? { border: "1px solid var(--border-subtle, var(--border))", color: text }
    : { background: `color-mix(in srgb, ${fill} 14%, transparent)`, color: text };
}

export function Pill({ semantic = "neutral", children, title, className = "" }: { semantic?: Semantic; children: ReactNode; title?: string; className?: string }) {
  return <span title={title} className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[11px] font-semibold leading-none ${className}`}
    style={tinted(semantic)}>{children}</span>;
}

// ---------------------------------------------------------------------------

const PRIORITY_BARS: Record<TaskPriority, number> = { none: 0, low: 1, normal: 2, high: 3, urgent: 3 };

/** Signal-bar priority mark; urgent is a filled warning square, never colour alone (the label is in the title). */
export function PriorityIcon({ priority, size = 14 }: { priority: TaskPriority; size?: number }) {
  const label = TASK_PRIORITY_LABEL[priority];
  if (priority === "urgent") {
    return <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 16 16" data-priority="urgent">
      <title>{label}</title>
      <rect x="1" y="1" width="14" height="14" rx="3.5" fill={SEMANTIC.danger.fill} />
      <rect x="7.1" y="3.8" width="1.8" height="5.4" rx="0.9" fill="var(--destructive-foreground)" />
      <circle cx="8" cy="11.6" r="1.05" fill="var(--destructive-foreground)" />
    </svg>;
  }
  const bars = PRIORITY_BARS[priority];
  return <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 16 16" data-priority={priority}>
    <title>{label}</title>
    {priority === "none"
      ? [2.5, 7, 11.5].map((x) => <rect key={x} x={x} y="7.2" width="2.4" height="1.6" rx="0.8" fill="currentColor" opacity="0.45" />)
      : [0, 1, 2].map((index) => <rect key={index} x={2 + index * 4.5} y={10 - index * 3.5} width="3" height={4 + index * 3.5} rx="1"
        fill="currentColor" opacity={index < bars ? 0.9 : 0.22} />)}
  </svg>;
}

/** Status mark: dashed ring, ring, half, ring with dot, check, cross. */
export function StatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  const label = TASK_STATUS_LABEL[status];
  const stroke = status === "done" ? SEMANTIC.success.fill : status === "in_progress" ? SEMANTIC.warning.fill
    : status === "in_review" ? SEMANTIC.info.fill : "var(--text-tertiary, var(--muted-foreground))";
  return <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 16 16" data-status={status} className="shrink-0">
    <title>{label}</title>
    {status === "done" ? <>
      <circle cx="8" cy="8" r="7" fill={stroke} />
      <path d="M5 8.2 7.1 10.2 11 6" fill="none" stroke="var(--bg-surface, var(--background))" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </> : status === "canceled" ? <>
      <circle cx="8" cy="8" r="7" fill={stroke} opacity="0.7" />
      <path d="M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4" stroke="var(--bg-surface, var(--background))" strokeWidth="1.6" strokeLinecap="round" />
    </> : <>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke={stroke} strokeWidth="1.6" strokeDasharray={status === "backlog" ? "2.4 2" : undefined} />
      {status === "in_progress" ? <path d="M8 4a4 4 0 0 1 0 8z" fill={stroke} /> : null}
      {status === "in_review" ? <circle cx="8" cy="8" r="2.6" fill={stroke} /> : null}
    </>}
  </svg>;
}

// ---------------------------------------------------------------------------

const AGENT_COPY: Record<TaskAgentStatus, { label: string; semantic: Semantic }> = {
  working: { label: "Working", semantic: "success" },
  blocked: { label: "Needs you", semantic: "warning" },
  error: { label: "Error", semantic: "danger" },
  done: { label: "Agent done", semantic: "info" },
  idle: { label: "Idle", semantic: "neutral" },
};

export function AgentStatusDot({ status }: { status: TaskAgentStatus }) {
  const { semantic } = AGENT_COPY[status];
  return <span aria-hidden="true" data-agent-status={status}
    className={`inline-block size-[7px] shrink-0 rounded-full${status === "working" ? " motion-safe:animate-pulse" : ""}`}
    style={{ background: SEMANTIC[semantic].fill }} />;
}

/** The card's rolled-up agent badge. */
export function AgentStatusBadge({ status }: { status: TaskAgentStatus }) {
  const { label, semantic } = AGENT_COPY[status];
  return <Pill semantic={semantic} title={`Agent status: ${label}`}><AgentStatusDot status={status} />{label}</Pill>;
}

const CHECKS_COPY = {
  passing: { label: "Checks passing", semantic: "success", icon: Check },
  failing: { label: "Checks failing", semantic: "danger", icon: X },
  pending: { label: "Checks running", semantic: "warning", icon: Clock3 },
  none: { label: "No checks", semantic: "neutral", icon: null },
} as const;

/** PR number plus state, with the checks roll-up while the PR is open. */
export function PullRequestBadge({ pr }: { pr: TaskPullRequest }) {
  const description = pullRequestDescription(pr);
  if (pr.state === "merged" || pr.state === "closed") {
    return <Pill semantic={pr.state === "merged" ? "info" : "neutral"} title={description}>
      <GitMerge size={11} aria-hidden />#{pr.number}<span className="sr-only">{pr.state === "merged" ? "merged" : "closed"}</span>
    </Pill>;
  }
  const checks = CHECKS_COPY[pr.checks];
  const CheckIcon = checks.icon;
  const StateIcon = pr.state === "draft" ? GitPullRequestDraft : GitPullRequest;
  return <Pill semantic={checks.semantic} title={description}>
    <StateIcon size={11} aria-hidden />#{pr.number}{CheckIcon ? <CheckIcon size={11} strokeWidth={2.5} aria-hidden /> : null}
    <span className="sr-only">{description}</span>
  </Pill>;
}

// ---------------------------------------------------------------------------

export function LabelChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return <span className="inline-flex h-5 max-w-[10rem] shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium leading-none"
    style={{ background: "var(--bg-sunken, var(--muted))", ...tone.secondary }}>
    <span className="truncate">{name}</span>
    {onRemove ? <button type="button" aria-label={`Remove label ${name}`} onClick={onRemove} className={`-mr-0.5 rounded ${focusRing}`}><X size={10} aria-hidden /></button> : null}
  </span>;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? "?").slice(0, 1)).toUpperCase();
}

export function ActorAvatar({ members, actor, size = 20 }: { members: readonly BoardMember[]; actor: ActorRef | null; size?: number }) {
  const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size * 0.42), background: "var(--bg-sunken, var(--muted))", ...tone.secondary };
  if (!actor) {
    return <span role="img" aria-label="Unassigned" title="Unassigned" className="grid shrink-0 place-items-center rounded-full border border-dashed"
      style={{ width: size, height: size, ...tone.border }} />;
  }
  const name = actorName(members, actor);
  if (actor.startsWith("agent:") || actor.startsWith("system:")) {
    return <span role="img" aria-label={name} title={name} className="grid shrink-0 place-items-center rounded-full" style={style}>
      <Bot size={Math.round(size * 0.6)} aria-hidden />
    </span>;
  }
  const avatarUrl = memberFor(members, actor)?.avatarUrl;
  return <span role="img" aria-label={name} title={name} className="grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold" style={style}>
    {avatarUrl ? <img src={avatarUrl} alt="" className="size-full object-cover" draggable={false} /> : initials(name)}
  </span>;
}

