import { AgentThreadEventSchema, SafeClientErrorSchema, type AgentThreadEvent, type ApprovalDecisionRequest, type UserInputAnswerRequest } from "@matrix-os/contracts";

export function safeProviderRunError() {
  return SafeClientErrorSchema.parse({
    code: "provider_run_failed",
    safeMessage: "Agent run could not continue. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

export function safeProviderRunFailureEvents(threadId: string, now: () => Date, eventId: () => string): AgentThreadEvent[] {
  return [
    AgentThreadEventSchema.parse({
      type: "thread.error",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      error: safeProviderRunError(),
    }),
    AgentThreadEventSchema.parse({
      type: "thread.completed",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      outcome: "failed",
    }),
  ];
}

export function defaultAbortEvents(threadId: string, now: () => Date, eventId: () => string): AgentThreadEvent[] {
  return [
    AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      status: "aborted",
    }),
    AgentThreadEventSchema.parse({
      type: "thread.completed",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      outcome: "aborted",
    }),
  ];
}

export function terminalStoppedEvents(
  threadId: string,
  runtimeStatus: "starting" | "running" | "idle" | "waiting" | "exited" | "failed" | "degraded",
  now: () => Date,
  eventId: () => string,
): AgentThreadEvent[] {
  const failed = runtimeStatus !== "exited";
  return [
    AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      status: failed ? "failed" : "completed",
    }),
    AgentThreadEventSchema.parse({
      type: "thread.completed",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      outcome: failed ? "failed" : "completed",
    }),
  ];
}

export function defaultApprovalDecisionEvents(
  threadId: string,
  approvalId: string,
  request: ApprovalDecisionRequest,
  now: () => Date,
  eventId: () => string,
): AgentThreadEvent[] {
  return [
    AgentThreadEventSchema.parse({
      type: "approval.resolved",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      approvalId,
      decision: request.decision,
    }),
    AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      status: "running",
    }),
  ];
}

export function defaultInputAnswerEvents(
  threadId: string,
  inputRequestId: string,
  request: UserInputAnswerRequest,
  now: () => Date,
  eventId: () => string,
): AgentThreadEvent[] {
  return [
    AgentThreadEventSchema.parse({
      type: "user_input.answered",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      requestId: inputRequestId,
      correlationId: request.correlationId,
    }),
    AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      status: "running",
    }),
  ];
}
