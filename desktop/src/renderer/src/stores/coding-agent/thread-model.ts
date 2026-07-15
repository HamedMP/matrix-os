import type {
  AgentThreadEvent,
  AgentThreadSnapshot,
  AgentThreadSummary,
  CreateAgentTurnError,
  FileReadRequest,
  RuntimeSummary,
} from "@matrix-os/contracts";

export type AgentThreadSnapshotEvent = AgentThreadSnapshot["events"]["items"][number];
export type FileReference = Pick<FileReadRequest, "projectId" | "worktreeId" | "path">;

export function safeTurnError(code: CreateAgentTurnError["code"]): string {
  if (code === "thread_busy") {
    return "This conversation is already running. Wait for it to finish and try again.";
  }
  if (code === "thread_not_found") {
    return "Conversation is unavailable. Refresh and try again.";
  }
  return "This conversation cannot accept a message right now. Refresh and try again.";
}

export function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function fileReferenceMatches(reference: FileReference | null, request: FileReference): boolean {
  return reference?.projectId === request.projectId
    && reference.worktreeId === request.worktreeId
    && reference.path === request.path;
}

export function compareThreadEvents(left: AgentThreadSnapshotEvent, right: AgentThreadSnapshotEvent): number {
  const occurredAt = left.occurredAt.localeCompare(right.occurredAt);
  return occurredAt === 0 ? left.eventId.localeCompare(right.eventId) : occurredAt;
}

export function mergeSelectedThreadSnapshot(
  current: AgentThreadSnapshot | null,
  next: AgentThreadSnapshot,
): AgentThreadSnapshot {
  if (!current || current.thread.id !== next.thread.id) return next;
  const eventById = new Map<string, AgentThreadSnapshotEvent>();
  for (const event of current.events.items) eventById.set(event.eventId, event);
  for (const event of next.events.items) eventById.set(event.eventId, event);
  const limit = Math.max(current.events.limit, next.events.limit);
  const items = Array.from(eventById.values())
    .sort(compareThreadEvents)
    .slice(-limit);
  const thread = current.thread.updatedAt > next.thread.updatedAt ? current.thread : next.thread;
  return {
    ...next,
    thread,
    events: {
      ...next.events,
      items,
      hasMore: current.events.hasMore || next.events.hasMore,
      limit,
    },
  };
}

export function summaryIncludesThread(summary: RuntimeSummary, threadId: string): boolean {
  return summary.activeThreads.items.some((thread) => thread.id === threadId)
    || summary.attentionThreads.items.some((thread) => thread.id === threadId);
}

// Reconciles one live-updated thread into the bounded summary lists: updates
// in place, drops it from attentionThreads when attention clears, and promotes
// it to the head of attentionThreads when a live event raises attention from
// "none" (#998). Promotion mirrors the gateway's attentionThread predicate
// (attention !== "none" && status !== "archived" in coding-agents/
// thread-store.ts) so the local list anticipates exactly what the next
// summary refresh returns; the refresh restores canonical ordering.
export function reconcileSummaryThread(
  summary: RuntimeSummary,
  thread: RuntimeSummary["activeThreads"]["items"][number],
): RuntimeSummary {
  const activeItems = summary.activeThreads.items.map((candidate) =>
    candidate.id === thread.id ? thread : candidate,
  );
  let attentionItems: typeof summary.attentionThreads.items;
  let attentionHasMore = summary.attentionThreads.hasMore;
  if (thread.attention === "none") {
    attentionItems = summary.attentionThreads.items.filter((candidate) => candidate.id !== thread.id);
  } else if (summary.attentionThreads.items.some((candidate) => candidate.id === thread.id)) {
    attentionItems = summary.attentionThreads.items.map((candidate) =>
      candidate.id === thread.id ? thread : candidate,
    );
  } else if (thread.status === "archived") {
    attentionItems = summary.attentionThreads.items;
  } else {
    attentionItems = [thread, ...summary.attentionThreads.items];
    const limit = summary.attentionThreads.limit;
    if (attentionItems.length > limit) {
      attentionItems = attentionItems.slice(0, limit);
      attentionHasMore = true;
    }
  }
  return {
    ...summary,
    activeThreads: {
      ...summary.activeThreads,
      items: activeItems,
    },
    attentionThreads: {
      ...summary.attentionThreads,
      items: attentionItems,
      hasMore: attentionHasMore,
    },
  };
}

export function attentionForThreadStatus(status: AgentThreadSummary["status"]): AgentThreadSummary["attention"] {
  switch (status) {
    case "waiting_for_approval":
      return "approval_required";
    case "waiting_for_input":
      return "input_required";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    default:
      return "none";
  }
}

export function reduceThreadSummaryEvent(
  thread: AgentThreadSummary,
  event: AgentThreadEvent,
): AgentThreadSummary {
  if (event.threadId !== thread.id) return thread;
  const updatedAt = latestIsoTimestamp(thread.updatedAt, event.occurredAt);
  switch (event.type) {
    case "thread.status":
      return { ...thread, status: event.status, attention: attentionForThreadStatus(event.status), updatedAt };
    case "approval.requested":
      return { ...thread, status: "waiting_for_approval", attention: "approval_required", updatedAt };
    case "approval.resolved":
      return { ...thread, status: "running", attention: "none", updatedAt };
    case "user_input.requested":
      return { ...thread, status: "waiting_for_input", attention: "input_required", updatedAt };
    case "user_input.answered":
      return { ...thread, status: "running", attention: "none", updatedAt };
    case "thread.error":
      return { ...thread, status: "failed", attention: "failed", updatedAt };
    case "thread.completed":
      return {
        ...thread,
        status: event.outcome,
        attention: event.outcome === "completed" ? "completed" : event.outcome === "failed" ? "failed" : "none",
        updatedAt,
      };
    default:
      return { ...thread, updatedAt };
  }
}

export function latestIsoTimestamp(a: string, b: string): string {
  return a.localeCompare(b) >= 0 ? a : b;
}

export function mergeLiveThreadEvent(
  current: AgentThreadSnapshot,
  event: AgentThreadEvent,
): AgentThreadSnapshot {
  if (event.threadId !== current.thread.id) return current;
  const existing = new Map(current.events.items.map((item) => [item.eventId, item]));
  existing.set(event.eventId, event);
  const limit = current.events.limit;
  const items = Array.from(existing.values())
    .sort(compareThreadEvents)
    .slice(-limit);
  return {
    ...current,
    thread: event.occurredAt.localeCompare(current.thread.updatedAt) >= 0
      ? reduceThreadSummaryEvent(current.thread, event)
      : current.thread,
    events: {
      ...current.events,
      items,
    },
  };
}
