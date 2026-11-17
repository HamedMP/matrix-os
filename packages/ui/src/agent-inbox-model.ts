import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import { terminalFactsKey, type TerminalTabFacts } from "./terminal-agents/attention.js";

export type AgentInboxGroup = "needs" | "running" | "done";
export type AgentInboxPill = "Approval" | "Question" | "Needs you" | "Failed" | "Stalled" | "Running" | "Done" | "Stopped" | "App";
export type AgentInboxAvatar = "claude" | "codex" | "hermes" | "pi" | "opencode" | "cursor" | "agent" | "app";
/** Where a row leads: a coding-agent thread (its chat), or one exact terminal tab. */
export type AgentInboxTarget =
  | { kind: "thread"; threadId: string; terminalKey?: string }
  | { kind: "terminal"; key: string };

export interface AgentInboxItem {
  key: string;
  group: AgentInboxGroup;
  pill: AgentInboxPill;
  avatar: AgentInboxAvatar;
  title: string;
  subline: string[];
  message?: string;
  at?: string;
  target?: AgentInboxTarget;
}

export interface AgentInboxModel {
  /** Ordered: needs you, running, done; newest first inside each group. */
  items: AgentInboxItem[];
  counts: Record<AgentInboxGroup | "all", number>;
  /** Some items were left out (bounded display or bounded server lists). */
  truncated: boolean;
}

export const AGENT_INBOX_GROUPS: readonly AgentInboxGroup[] = ["needs", "running", "done"];
/** Display bound per group; terminal facts alone may hold thousands of tabs. */
export const MAX_AGENT_INBOX_GROUP_ITEMS = 30;
const GENERIC_THREAD_TITLE = "coding agent run";
/** A failure or stall nobody acted on for a day is history, not a request for the owner. */
export const AGENT_INBOX_NEEDS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ThreadPlacement = { group: AgentInboxGroup; pill: AgentInboxPill } | null;

export function threadPlacement(thread: Pick<AgentThreadSummary, "status" | "attention">): ThreadPlacement {
  if (thread.status === "waiting_for_approval" || thread.attention === "approval_required") return { group: "needs", pill: "Approval" };
  if (thread.status === "waiting_for_input" || thread.attention === "input_required") return { group: "needs", pill: "Question" };
  if (thread.status === "failed" || thread.attention === "failed") return { group: "needs", pill: "Failed" };
  if (thread.status === "stale") return { group: "needs", pill: "Stalled" };
  if (thread.status === "queued" || thread.status === "starting" || thread.status === "running") return { group: "running", pill: "Running" };
  if (thread.status === "completed") return { group: "done", pill: "Done" };
  if (thread.status === "aborted") return { group: "done", pill: "Stopped" };
  return null;
}

function terminalPlacement(facts: TerminalTabFacts): ThreadPlacement {
  if (facts.state !== "live") return null;
  switch (facts.agentStatus) {
    case "blocked": return { group: "needs", pill: "Needs you" };
    case "error": return { group: "needs", pill: "Failed" };
    case "working": return { group: "running", pill: "Running" };
    case "done": return { group: "done", pill: "Done" };
    default: return null;
  }
}

const AVATAR_WORDS: ReadonlyArray<[RegExp, AgentInboxAvatar]> = [
  [/\bclaude\b/i, "claude"], [/\bcodex\b/i, "codex"], [/\bhermes\b/i, "hermes"],
  [/\bopencode\b/i, "opencode"], [/\bcursor\b/i, "cursor"], [/\bpi\b/i, "pi"],
];

function avatarFromText(text: string): AgentInboxAvatar {
  return AVATAR_WORDS.find(([pattern]) => pattern.test(text))?.[1] ?? "agent";
}

function timeOf(at: string | undefined): number {
  const value = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

function compact(parts: ReadonlyArray<string | undefined>): string[] {
  return parts.filter((part): part is string => Boolean(part && part.trim()));
}

/**
 * The shared inbox model for every OS view: coding-agent threads from the runtime
 * summary plus live Herdr-style terminal agents, deduplicated by terminal tab.
 * Pure and bounded; renderers only supply the data and the open actions.
 */
export function deriveAgentInbox(input: {
  summary: RuntimeSummary | null;
  terminalTabs?: Readonly<Record<string, TerminalTabFacts>>;
}): AgentInboxModel {
  const { summary } = input;
  const tabs = input.terminalTabs ?? {};
  const providers = new Map((summary?.providers ?? []).map((provider) => [provider.id, provider]));
  const projects = new Map((summary?.projects.items ?? []).map((project) => [project.id, project.label]));
  const tabNames = new Map<string, string>();
  for (const workspace of summary?.terminalWorkspaces.items ?? []) {
    for (const tab of workspace.tabs) tabNames.set(terminalFactsKey({ workspaceId: tab.workspaceId, tabId: tab.id }), tab.name);
  }
  const serverNow = timeOf(summary?.serverTime);
  const projectLabel = (projectId: string | undefined) => (projectId ? projects.get(projectId) ?? projectId : undefined);

  const all: AgentInboxItem[] = [];
  const claimedTabs = new Set<string>();
  const seenThreads = new Set<string>();
  // Attention first: when lists overlap, it carries the actionable state.
  const threads = [
    ...(summary?.attentionThreads.items ?? []),
    ...(summary?.activeThreads.items ?? []),
    ...(summary?.recentThreads.items ?? []),
  ];
  for (const thread of threads) {
    if (seenThreads.has(thread.id)) continue;
    seenThreads.add(thread.id);
    const placed = threadPlacement(thread);
    if (!placed) continue;
    const terminalKey = thread.terminalRef ? terminalFactsKey(thread.terminalRef) : undefined;
    const facts = terminalKey ? tabs[terminalKey] : undefined;
    if (terminalKey) claimedTabs.add(terminalKey);
    // A "running" thread whose live tab is asking for something needs the owner now;
    // explicit approval, question and failure states on the thread still win.
    const blocked = placed.group === "running" && facts?.state === "live" && facts.agentStatus === "blocked";
    const expired = serverNow > 0 && serverNow - timeOf(thread.updatedAt) > AGENT_INBOX_NEEDS_MAX_AGE_MS;
    // A day-old failure or stall is history; a "running" run silent for a day is stuck.
    const placement: NonNullable<ThreadPlacement> = blocked ? { group: "needs", pill: "Needs you" }
      : !expired ? placed
        : placed.pill === "Failed" || placed.pill === "Stalled" ? { ...placed, group: "done" }
          : placed.group === "running" ? { group: "done", pill: "Stalled" } : placed;
    const provider = providers.get(thread.providerId);
    const providerName = provider?.displayName ?? thread.providerId;
    const tabName = facts?.name ?? (terminalKey ? tabNames.get(terminalKey) : undefined);
    const project = projectLabel(thread.projectId);
    const ownTitle = thread.title.trim();
    const title = ownTitle && ownTitle.toLowerCase() !== GENERIC_THREAD_TITLE
      ? ownTitle
      : tabName ?? (project ? `${providerName} run in ${project}` : `${providerName} run`);
    const activity = placement.group === "running" ? facts?.statusMessage : undefined;
    all.push({
      key: `thread:${thread.id}`,
      ...placement,
      avatar: provider ? (provider.kind === "custom" ? avatarFromText(provider.id) : provider.kind) : avatarFromText(thread.providerId),
      title,
      subline: compact([providerName, project, activity ?? (tabName !== title ? tabName : undefined)]),
      ...(placement.group !== "running" && facts?.statusMessage ? { message: facts.statusMessage } : {}),
      at: thread.updatedAt,
      target: { kind: "thread", threadId: thread.id, ...(terminalKey ? { terminalKey } : {}) },
    });
  }

  for (const facts of Object.values(tabs)) {
    const key = terminalFactsKey(facts.ref);
    if (claimedTabs.has(key)) continue;
    const placement = terminalPlacement(facts);
    if (!placement) continue;
    all.push({
      key: `terminal:${key}`,
      ...placement,
      avatar: avatarFromText(facts.name),
      title: facts.name,
      subline: compact(["Terminal", projectLabel(facts.projectId), placement.group === "running" ? facts.statusMessage : undefined]),
      ...(placement.group !== "running" && facts.statusMessage ? { message: facts.statusMessage } : {}),
      ...(facts.statusAt ? { at: facts.statusAt } : {}),
      target: { kind: "terminal", key },
    });
  }

  for (const event of summary?.recentActivity.items ?? []) {
    all.push({ key: `activity:${event.id}`, group: "done", pill: "App", avatar: "app", title: event.label, subline: [], at: event.occurredAt });
  }

  const counts = { all: all.length, needs: 0, running: 0, done: 0 };
  const items: AgentInboxItem[] = [];
  for (const group of AGENT_INBOX_GROUPS) {
    const members = all.filter((item) => item.group === group).sort((left, right) => timeOf(right.at) - timeOf(left.at));
    counts[group] = members.length;
    items.push(...members.slice(0, MAX_AGENT_INBOX_GROUP_ITEMS));
  }
  const truncated = items.length < all.length || Boolean(
    summary?.attentionThreads.hasMore || summary?.activeThreads.hasMore || summary?.recentThreads.hasMore || summary?.recentActivity.hasMore,
  );
  return { items, counts, truncated };
}

/** "now", "3m", "2h", "4d"; empty for an unknown time. */
export function formatInboxTime(at: string | undefined, now: number): string {
  const time = timeOf(at);
  if (!time) return "";
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
