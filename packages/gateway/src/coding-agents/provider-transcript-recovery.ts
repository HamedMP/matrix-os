import type { AgentThreadEvent } from "@matrix-os/contracts";
import { completionEvents } from "./codex-terminal-events.js";
import { z } from "zod/v4";
import type { StoredThreadState } from "./thread-store.js";
import { boundedOperation } from "../bounded-operation.js";

export interface ProviderIdleObservation {
  ownerId: string;
  backgroundRefId: string;
  sessionId: string;
  providerThreadId: string;
  requestId?: string;
}

const CursorSchema = z.object({
  sessionId: z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/),
  expectedOffset: z.number().int().min(1).max(16 * 1024 * 1024),
}).strict();

export function providerTranscriptUnavailable(thread: StoredThreadState["threads"][number], events: readonly AgentThreadEvent[]): boolean {
  const error = events.findLast(event => event.threadId === thread.id && event.type === "thread.error");
  return thread.providerId === "codex" && thread.status === "failed"
    && error?.type === "thread.error" && error.error.code === "agent_history_unavailable";
}

/** Called under the existing owner-store mutation lock; no native prompt is sent. */
export async function applyProviderTranscriptRecovery(state: StoredThreadState, input: {
  ownerId: string;
  threadId: string;
  cursor: z.input<typeof CursorSchema>;
  proveIdle: (observation: ProviderIdleObservation) => Promise<boolean>;
  now: () => Date;
  nextEventId: () => string;
}) {
  const cursor = CursorSchema.parse(input.cursor);
  const thread = state.threads.find(candidate => candidate.id === input.threadId && candidate.ownerId === input.ownerId);
  if (!thread || thread.providerId !== "codex" || thread.activeTurnId
    || !["queued", "starting", "running", "waiting_for_approval", "waiting_for_input"].includes(thread.status)
    || thread.providerResumeState?.conversationId !== cursor.sessionId
    || thread.providerEventOffset !== cursor.expectedOffset || !thread.providerResumeState.providerThreadId
    || !thread.providerResumeState.backgroundRef) {
    return { state, result: [] as AgentThreadEvent[] };
  }
  const observation: ProviderIdleObservation = { ownerId: input.ownerId, backgroundRefId: thread.providerResumeState.backgroundRef.id,
    sessionId: cursor.sessionId, providerThreadId: thread.providerResumeState.providerThreadId,
    ...(thread.deliveredTurnId ? { requestId: `req_${thread.deliveredTurnId.slice("turn_".length)}` } : {}) };
  if (!await boundedOperation(() => input.proveIdle(observation), 5_000)) {
    return { state, result: [] as AgentThreadEvent[] };
  }
  const occurredAt = input.now().toISOString();
  const events = completionEvents({ threadId: thread.id, outcome: "failed", failureReason: "history_unavailable",
    occurredAt, nextEventId: input.nextEventId });
  // A shorter stream cannot prove which output/terminal belongs to this turn.
  // Preserve committed text and report lost history rather than fabricate success.
  const { deliveredTurnId: _delivered, ...rest } = thread;
  const next = { ...rest, status: "failed" as const, attention: "failed" as const, updatedAt: occurredAt };
  return { state: { ...state, threads: state.threads.map(candidate => candidate === thread ? next : candidate),
    events: [...state.events, ...events] }, result: events };
}
