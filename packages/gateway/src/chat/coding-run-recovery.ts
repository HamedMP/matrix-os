import { z } from "zod/v4";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { CodingAgentProviderResumeStateSchema } from "../coding-agents/provider-adapter.js";

import { RecoveredControlActivitySchema, type RecoveredControlActivity } from "./provider-adapter.js";

function recoveryControl(event: AgentThreadEvent): RecoveredControlActivity | undefined {
  if (event.type === "approval.requested") return RecoveredControlActivitySchema.parse({
    type: event.type, approvalId: event.approval.approvalId, title: event.approval.title,
    risk: event.approval.risk, allowedDecisions: event.approval.allowedDecisions,
  });
  if (event.type === "approval.resolved") return RecoveredControlActivitySchema.parse({
    type: event.type, approvalId: event.approvalId, decision: event.decision,
  });
  if (event.type === "user_input.requested") return RecoveredControlActivitySchema.parse({
    type: "input.requested", requestId: event.request.requestId, title: event.request.title,
  });
  if (event.type === "user_input.answered") return RecoveredControlActivitySchema.parse({
    type: "input.resolved", requestId: event.requestId,
  });
  return undefined;
}

export const CodingChatStateSchema = CodingAgentProviderResumeStateSchema.extend({
  runId: z.string().regex(/^run_[A-Za-z0-9_-]+$/).optional(),
  replayAfter: z.string().min(1).max(512).optional(),
});
export type CodingChatState = z.infer<typeof CodingChatStateSchema>;

export function recoveryState(conversationId: string, runId: string, events: AgentThreadEvent[]): CodingChatState {
  const requestId = `req_${runId.slice(4)}`;
  const boundary = events.find((event) =>
    (event.type === "user.message" || event.type === "turn.accepted") && event.clientRequestId === requestId);
  return { conversationId, runId, ...(boundary ? { replayAfter: boundary.eventId } : {}) };
}

export async function recoverCodingRun(input: {
  runId: string;
  state: CodingChatState;
  signal: AbortSignal;
  includePending?: boolean;
  read: (cursor?: string) => Promise<AgentThreadSnapshot>;
}) {
  // Old clients/states remain valid. Recover only when a durable exact-run
  // boundary exists; never attach another turn's final answer to this run.
  let cursor = input.state.runId === input.runId ? input.state.replayAfter : undefined;
  const messages = new Map<string, string>();
  let bytes = 0;
  const activities: RecoveredControlActivity[] = [];
  const requestId = `req_${input.runId.slice(4)}`;
  for (let page = 0; page < 50; page += 1) {
    input.signal.throwIfAborted();
    const snapshot = await input.read(cursor);
    input.signal.throwIfAborted();
    let events = snapshot.events.items;
    if (!cursor) {
      const boundary = events.findIndex((event) =>
        (event.type === "user.message" || event.type === "turn.accepted") && event.clientRequestId === requestId);
      if (boundary < 0) return null;
      events = events.slice(boundary + 1);
    }
    for (const event of events) {
      if ((event.type === "user.message" || event.type === "turn.accepted") && event.clientRequestId !== requestId) return null;
      if (input.includePending) {
        const activity = recoveryControl(event);
        if (activity) {
          if (activities.length >= 100) throw new Error("Recovery control limit exceeded");
          activities.push(activity);
        }
      }
      if (event.type === "assistant.text.delta") {
        if (!messages.has(event.messageId) && messages.size >= 256) throw new Error("Recovery message limit exceeded");
        bytes += Buffer.byteLength(event.delta);
        if (bytes > 96 * 1024) throw new Error("Recovery output limit exceeded");
        messages.set(event.messageId, (messages.get(event.messageId) ?? "") + event.delta);
      }
      if (event.type === "thread.completed" || event.type === "thread.error") {
        return {
          outcome: event.type === "thread.error" ? "failed" as const : event.outcome,
          messages: [...messages].map(([messageId, text]) => ({ messageId, text })),
          ...(activities.length ? { activities } : {}),
        };
      }
    }
    // Without a cursor hasMore describes older omitted history, not another
    // forward page. Never loop backward through a truncated tail.
    if (!cursor || !snapshot.events.hasMore || !snapshot.events.nextCursor || snapshot.events.nextCursor === cursor) {
      if (input.includePending && ["queued", "starting", "running", "waiting_for_approval", "waiting_for_input"].includes(snapshot.thread.status)) {
        return { outcome: "pending" as const, activities, messages: [...messages].map(([messageId, text]) => ({ messageId, text })) };
      }
      return null;
    }
    cursor = snapshot.events.nextCursor;
  }
  throw new Error("Recovery replay limit exceeded");
}
