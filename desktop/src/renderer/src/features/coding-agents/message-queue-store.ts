// Client-side follow-up queue for coding-agent threads. There is no backend
// turn queue yet: while a thread is busy, the composer enqueues here and the
// conversation drains the queue FIFO when the turn completes. Queues are
// keyed by thread so they survive view switches, and are bounded per thread
// and globally (stalest-thread eviction) so a runaway composer cannot grow
// renderer memory without limit.
import { create } from "zustand";

// Matches the CreateAgentTurnRequestSchema message cap so a queued message can
// never be rejected for size when it drains.
export const MAX_QUEUED_MESSAGE_CHARS = 24_000;
export const MAX_QUEUED_MESSAGES_PER_THREAD = 20;
export const MAX_QUEUED_THREADS = 50;

export interface QueuedAgentMessage {
  id: string;
  text: string;
  queuedAt: number;
}

interface CodingAgentMessageQueueState {
  queues: Record<string, QueuedAgentMessage[]>;
  /** Appends a message; returns it, or null when rejected (empty, oversized, full). */
  enqueue: (threadId: string, text: string) => QueuedAgentMessage | null;
  removeQueued: (threadId: string, messageId: string) => void;
  /** Puts a previously drained message back at the head (failed send); idempotent by id. */
  requeueFront: (threadId: string, message: QueuedAgentMessage) => void;
  clearThreadQueue: (threadId: string) => void;
}

let queuedMessageSeq = 0;

function nextQueuedMessageId(): string {
  queuedMessageSeq += 1;
  return `queued_${Date.now().toString(36)}_${queuedMessageSeq}`;
}

function withoutEmptyThread(
  queues: Record<string, QueuedAgentMessage[]>,
  threadId: string,
  messages: QueuedAgentMessage[],
): Record<string, QueuedAgentMessage[]> {
  if (messages.length > 0) return { ...queues, [threadId]: messages };
  const next = { ...queues };
  delete next[threadId];
  return next;
}

/** Drops the thread whose newest message is the oldest; used only at capacity. */
function evictStalestThread(queues: Record<string, QueuedAgentMessage[]>): Record<string, QueuedAgentMessage[]> {
  let stalestThreadId: string | null = null;
  let stalestTouchedAt = Number.POSITIVE_INFINITY;
  for (const [threadId, messages] of Object.entries(queues)) {
    const touchedAt = messages.at(-1)?.queuedAt ?? 0;
    if (touchedAt < stalestTouchedAt) {
      stalestTouchedAt = touchedAt;
      stalestThreadId = threadId;
    }
  }
  if (stalestThreadId === null) return queues;
  const next = { ...queues };
  delete next[stalestThreadId];
  return next;
}

export const useCodingAgentMessageQueue = create<CodingAgentMessageQueueState>()((set, get) => ({
  queues: {},

  enqueue: (threadId, text) => {
    if (!threadId || !text.trim() || text.length > MAX_QUEUED_MESSAGE_CHARS) return null;
    const current = get().queues;
    const existing = current[threadId] ?? [];
    if (existing.length >= MAX_QUEUED_MESSAGES_PER_THREAD) return null;
    let next = current;
    if (!current[threadId] && Object.keys(current).length >= MAX_QUEUED_THREADS) {
      next = evictStalestThread(current);
    }
    const message: QueuedAgentMessage = {
      id: nextQueuedMessageId(),
      text,
      queuedAt: Date.now(),
    };
    set({ queues: { ...next, [threadId]: [...(next[threadId] ?? []), message] } });
    return message;
  },

  removeQueued: (threadId, messageId) => {
    const existing = get().queues[threadId];
    if (!existing) return;
    set((state) => ({
      queues: withoutEmptyThread(
        state.queues,
        threadId,
        existing.filter((message) => message.id !== messageId),
      ),
    }));
  },

  requeueFront: (threadId, message) => {
    const existing = get().queues[threadId] ?? [];
    if (existing.some((candidate) => candidate.id === message.id)) return;
    if (existing.length >= MAX_QUEUED_MESSAGES_PER_THREAD) return;
    set((state) => ({ queues: { ...state.queues, [threadId]: [message, ...existing] } }));
  },

  clearThreadQueue: (threadId) => {
    if (!get().queues[threadId]) return;
    set((state) => {
      const next = { ...state.queues };
      delete next[threadId];
      return { queues: next };
    });
  },
}));

/** Stable empty slice for selectors (avoids allocating a fresh array per render). */
export const EMPTY_QUEUED_MESSAGES: QueuedAgentMessage[] = [];
