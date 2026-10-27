import { AgentThreadEventSchema, SafeClientErrorSchema, canonicalAgentFailure, type AgentThreadEvent } from "@matrix-os/contracts";
import type { CodexFailureReason } from "./codex-terminal-failure.mjs";

export function completionEvents(input: {
  threadId: string;
  outcome: "completed" | "failed" | "aborted";
  occurredAt: string;
  nextEventId: () => string;
  failureReason?: CodexFailureReason | "transcript_interrupted";
}): AgentThreadEvent[] {
  const events: AgentThreadEvent[] = [];
  if (input.outcome === "failed") {
    const classified = canonicalAgentFailure(input.failureReason);
    events.push(AgentThreadEventSchema.parse({
      type: "thread.error",
      eventId: input.nextEventId(),
      threadId: input.threadId,
      occurredAt: input.occurredAt,
      error: SafeClientErrorSchema.parse(classified ? {
        code: `agent_${input.failureReason}`,
        safeMessage: classified.safeMessage,
        retryable: classified.retryable,
        recoveryActions: classified.retryable ? ["retry"]
          : input.failureReason === "authentication_required" ? ["sign_in", "open_setup_terminal"]
          : classified.recoveryActions?.includes("start_new_chat") ? ["start_new_session"] : ["select_runtime"],
      } : {
        code: "provider_failed",
        safeMessage: "The coding agent stopped. Review the thread and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      }),
    }));
  }
  events.push(AgentThreadEventSchema.parse({
    type: "thread.completed",
    eventId: input.nextEventId(),
    threadId: input.threadId,
    occurredAt: input.occurredAt,
    outcome: input.outcome,
  }));
  return events;
}
