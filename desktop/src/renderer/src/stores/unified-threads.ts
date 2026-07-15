// One UI thread model over two distinct backends: local kernel-WS agent runs
// (stores/threads.ts) and server-backed coding-agent threads (RuntimeSummary
// projections). Pure derivation only — this module owns no state, so the two
// systems cannot diverge through it. See
// specs/105-coding-agent-shells/desktop-thread-unification.md.
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import type { AgentThread, ThreadStatus } from "./threads";

export type UnifiedThreadSource = "kernel" | "coding-agent";
export type UnifiedThreadStatus = ThreadStatus;

export interface UnifiedThreadItem {
  source: UnifiedThreadSource;
  id: string;
  title: string;
  status: UnifiedThreadStatus;
  unread: boolean;
  updatedAt: number;
}

export const UNIFIED_THREAD_STATUS_META: Record<UnifiedThreadStatus, { label: string; color: string }> = {
  running: { label: "Running", color: "var(--status-running)" },
  "needs-attention": { label: "Needs attention", color: "var(--status-attention)" },
  done: { label: "Done", color: "var(--status-complete)" },
  failed: { label: "Failed", color: "var(--status-failed)" },
  aborted: { label: "Aborted", color: "var(--status-todo)" },
};

// Server thread ids come from ThreadIdSchema (`thread_` prefix); local kernel
// thread ids are `thread-<epoch>-<seq>`. The namespaces cannot collide.
const SERVER_THREAD_ID_PREFIX = "thread_";

export function kernelThreadToUnified(thread: AgentThread): UnifiedThreadItem {
  return {
    source: "kernel",
    id: thread.id,
    title: thread.title,
    status: thread.status,
    unread: thread.unread,
    updatedAt: thread.updatedAt,
  };
}

function codingAgentUnifiedStatus(thread: AgentThreadSummary): UnifiedThreadStatus {
  if (thread.attention === "approval_required" || thread.attention === "input_required") {
    return "needs-attention";
  }
  switch (thread.status) {
    case "queued":
    case "starting":
    case "running":
      return "running";
    case "waiting_for_approval":
    case "waiting_for_input":
      return "needs-attention";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      // aborted, stale, archived: no longer executing and needs no action.
      return "aborted";
  }
}

export function codingAgentThreadToUnified(thread: AgentThreadSummary): UnifiedThreadItem {
  const parsed = Date.parse(thread.updatedAt);
  return {
    source: "coding-agent",
    id: thread.id,
    title: thread.title,
    status: codingAgentUnifiedStatus(thread),
    unread: thread.attention === "approval_required" || thread.attention === "input_required",
    updatedAt: Number.isNaN(parsed) ? 0 : parsed,
  };
}

/**
 * Merges kernel threads with the summary's active and attention lists into one
 * recency-sorted rail model. Attention entries win the dedupe because they
 * carry the actionable state. Inputs are already bounded (kernel store caps at
 * 100, summary lists are server-limited), so the result is bounded too.
 */
export function listUnifiedThreads(
  kernelThreads: AgentThread[],
  summary: RuntimeSummary | null,
): UnifiedThreadItem[] {
  const items = kernelThreads.map(kernelThreadToUnified);
  if (summary) {
    const byId = new Map<string, AgentThreadSummary>();
    for (const thread of summary.activeThreads.items) byId.set(thread.id, thread);
    for (const thread of summary.attentionThreads.items) byId.set(thread.id, thread);
    for (const thread of byId.values()) items.push(codingAgentThreadToUnified(thread));
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function kernelThreadAttentionCount(threads: AgentThread[]): number {
  return threads.reduce(
    (sum, thread) => sum + (thread.unread || thread.status === "needs-attention" ? 1 : 0),
    0,
  );
}

export function codingAgentAttentionCount(summary: RuntimeSummary | null): number {
  const attentionThreads = summary?.attentionThreads;
  if (!attentionThreads) return 0;
  return attentionThreads.hasMore ? 999 : attentionThreads.items.length;
}

export function unifiedAttentionCount(
  kernelThreads: AgentThread[],
  summary: RuntimeSummary | null,
): number {
  return kernelThreadAttentionCount(kernelThreads) + codingAgentAttentionCount(summary);
}

export type ThreadNotificationRoute =
  | { target: "chat"; select: string | null }
  | { target: "coding-agent"; select: string };

/**
 * Decides which surface a thread notification belongs to. Kernel threads are
 * matched by presence (their store is the only authority for local ids);
 * otherwise the server id namespace routes to the coding-agent workspace. A
 * kernel-format id that is no longer in the store (runtime switch cleared it)
 * opens chat with no selection rather than feeding a foreign-namespace id to
 * the coding-agent snapshot loader.
 */
export function routeThreadNotification(
  threadId: string,
  kernelThreadIds: readonly string[],
): ThreadNotificationRoute {
  if (kernelThreadIds.includes(threadId)) return { target: "chat", select: threadId };
  if (threadId.startsWith(SERVER_THREAD_ID_PREFIX)) return { target: "coding-agent", select: threadId };
  return { target: "chat", select: null };
}
