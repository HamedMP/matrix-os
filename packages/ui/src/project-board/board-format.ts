import type { ActorRef, BoardMember, TaskAgentStatus, TaskPullRequest } from "./types.js";

const AGENT_LABEL: Record<TaskAgentStatus, string> = { working: "Working", blocked: "Needs you", error: "Error", done: "Agent done", idle: "Idle" };

export function agentStatusLabel(status: TaskAgentStatus): string {
  return AGENT_LABEL[status];
}

export const CHECKS_LABEL: Record<TaskPullRequest["checks"], string> = {
  passing: "Checks passing", failing: "Checks failing", pending: "Checks running", none: "No checks",
};

const REVIEW_COPY: Record<TaskPullRequest["review"], string> = {
  approved: "Approved", changes_requested: "Changes requested", review_required: "Review requested", none: "",
};

export function pullRequestDescription(pr: TaskPullRequest): string {
  const state = pr.state === "open" ? "Open" : pr.state === "draft" ? "Draft" : pr.state === "merged" ? "Merged" : "Closed";
  return [`Pull request #${pr.number}`, state, pr.state === "open" || pr.state === "draft" ? CHECKS_LABEL[pr.checks] : "", REVIEW_COPY[pr.review]]
    .filter(Boolean).join(" · ");
}

export function memberFor(members: readonly BoardMember[], actor: ActorRef | null): BoardMember | undefined {
  return actor ? members.find((member) => member.actor === actor) : undefined;
}

/** Display name for any actor, including agents and system sources that are not members. */
export function actorName(members: readonly BoardMember[], actor: ActorRef): string {
  const member = memberFor(members, actor);
  if (member) return member.name;
  if (actor.startsWith("agent:")) return "Agent";
  if (actor === "system:automation") return "Automation";
  if (actor === "system:linear") return "Linear";
  return "Someone";
}

const DAY_MS = 86_400_000;

/** Relative time for timelines: "now", "5m", "3h", "2d", then a date. */
export function formatRelative(iso: string, nowMs: number): string {
  const delta = nowMs - Date.parse(iso);
  if (!Number.isFinite(delta)) return "";
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < DAY_MS) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 7 * DAY_MS) return `${Math.floor(delta / DAY_MS)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function localMidnight(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * "Due today" and "Due tomorrow" compare local calendar dates; "Overdue" means the deadline itself has passed,
 * which can happen earlier on the due day.
 */
export function formatDue(iso: string, nowMs: number): { label: string; overdue: boolean } {
  const due = Date.parse(iso);
  const date = new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (due < nowMs) return { label: `Overdue · ${date}`, overdue: true };
  // Round, so a day that is 23 or 25 hours long across a daylight saving change still counts as one.
  const days = Math.round((localMidnight(due) - localMidnight(nowMs)) / DAY_MS);
  if (days === 0) return { label: "Due today", overdue: false };
  if (days === 1) return { label: "Due tomorrow", overdue: false };
  return { label: `Due ${date}`, overdue: false };
}
