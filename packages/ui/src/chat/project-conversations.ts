import type { AgentThreadSummary, CanonicalProviderDriverKind } from "@matrix-os/contracts";
import { threadPlacement, type AgentInboxGroup, type AgentInboxPill } from "../agent-inbox-model.js";
import { CODING_AGENT_ARTWORK } from "../coding-agent-artwork.js";
import type { ChatNavigationRecord } from "../chat-navigation/projection.js";

export type ProjectConversationStatusFilter = AgentInboxGroup | "all";
export type ProjectConversationSort = "activity" | "created" | "title";
export type ProjectConversationArtwork = keyof typeof CODING_AGENT_ARTWORK;

export const PROJECT_CONVERSATION_STATUS_FILTERS: ReadonlyArray<{ id: ProjectConversationStatusFilter; label: string }> = [
  { id: "all", label: "All" }, { id: "needs", label: "Needs you" }, { id: "running", label: "Running" }, { id: "done", label: "Done" },
];
export const PROJECT_CONVERSATION_SORTS: ReadonlyArray<{ value: ProjectConversationSort; label: string }> = [
  { value: "activity", label: "Last activity" }, { value: "created", label: "Created" }, { value: "title", label: "Title A–Z" },
];
/** Rows rendered per page; the source projection itself is bounded upstream. */
export const PROJECT_CONVERSATION_PAGE_SIZE = 50;
const MAX_SNIPPET_CHARS = 160;

export interface ProjectConversationRow {
  record: ChatNavigationRecord;
  id: string;
  title: string;
  group: AgentInboxGroup;
  pill: AgentInboxPill;
  /** Stable filter key for the bound agent harness; "agent" when none is bound yet. */
  agent: string;
  agentLabel: string;
  artwork?: ProjectConversationArtwork;
  activityAt: number;
  createdAt: number;
  snippet?: string;
}

export interface ProjectConversationQuery {
  search: string;
  status: ProjectConversationStatusFilter;
  agent: string;
  sort: ProjectConversationSort;
}

const AGENTS: Partial<Record<CanonicalProviderDriverKind, { label: string; artwork?: ProjectConversationArtwork }>> = {
  claude_code: { label: "Claude Code", artwork: "claude" },
  codex: { label: "Codex", artwork: "codex" },
  hermes: { label: "Hermes", artwork: "hermes" },
  openclaw: { label: "OpenClaw", artwork: "openclaw" },
  opencode: { label: "OpenCode", artwork: "opencode" },
  pi: { label: "Pi", artwork: "pi" },
  matrix_pi: { label: "Matrix AI", artwork: "pi" },
  kernel: { label: "Matrix" },
  matrix_bot: { label: "Bot" },
};

function timeOf(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Canonical Chats speak the same status vocabulary as the agent inbox: the
 * record is translated to a thread status and placed by the inbox's own rule.
 */
export function projectConversationPlacement(record: ChatNavigationRecord): { group: AgentInboxGroup; pill: AgentInboxPill } {
  const run = record.activeRun?.status;
  const status: AgentThreadSummary["status"] = run === "accepted" ? "queued"
    : run ?? (record.chat.attention === "failed" ? "failed" : "completed");
  // A live run supersedes a failure left over from an earlier one.
  const attention: AgentThreadSummary["attention"] = run && record.chat.attention === "failed" ? "none" : record.chat.attention;
  return threadPlacement({ status, attention }) ?? { group: "done", pill: "Done" };
}

export function toProjectConversationRow(record: ChatNavigationRecord, snippet?: string): ProjectConversationRow {
  const driver = record.providerBinding?.driverKind;
  const agent = driver ? AGENTS[driver] : undefined;
  const preview = (snippet ?? ("lastMessagePreview" in record.chat ? String(record.chat.lastMessagePreview ?? "") : "")).trim();
  return {
    record,
    id: record.chat.id,
    title: record.chat.title.trim() || "Untitled chat",
    ...projectConversationPlacement(record),
    agent: driver ?? "agent",
    agentLabel: agent?.label ?? "Agent",
    ...(agent?.artwork ? { artwork: agent.artwork } : {}),
    activityAt: timeOf(record.chat.activityAt ?? record.chat.updatedAt),
    createdAt: timeOf(record.chat.createdAt),
    ...(preview ? { snippet: preview.length > MAX_SNIPPET_CHARS ? `${preview.slice(0, MAX_SNIPPET_CHARS - 1)}…` : preview } : {}),
  };
}

/** Distinct bound agents, in first-seen order, for the agent filter. */
export function projectConversationAgents(rows: readonly ProjectConversationRow[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const row of rows) if (!seen.has(row.agent)) seen.set(row.agent, row.agentLabel);
  return [...seen].map(([value, label]) => ({ value, label }));
}

export function projectConversationCounts(rows: readonly ProjectConversationRow[]): Record<ProjectConversationStatusFilter, number> {
  const counts = { all: rows.length, needs: 0, running: 0, done: 0 };
  for (const row of rows) counts[row.group] += 1;
  return counts;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Pure search, filter and sort; ties fall back to the Chat id so order is stable. */
export function queryProjectConversations(rows: readonly ProjectConversationRow[], query: ProjectConversationQuery): ProjectConversationRow[] {
  const search = query.search.trim().toLocaleLowerCase();
  const matches = rows.filter((row) => (query.status === "all" || row.group === query.status)
    && (query.agent === "all" || row.agent === query.agent)
    && (!search || row.title.toLocaleLowerCase().includes(search)));
  const compare = (left: ProjectConversationRow, right: ProjectConversationRow) => {
    const primary = query.sort === "title" ? collator.compare(left.title, right.title)
      : query.sort === "created" ? right.createdAt - left.createdAt
      : right.activityAt - left.activityAt;
    return primary || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  };
  return matches.sort(compare);
}
