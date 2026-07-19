import { z } from "zod/v4";
import {
  AgentThreadEventSchema,
  type AgentProviderSummary,
  type AgentThreadEvent,
  type AgentThreadSummary,
  type ApprovalDecisionRequest,
  type CreateAgentThreadRequest,
  type CreateAgentTurnRequest,
  type SafeSetupAction,
  type UserInputAnswerRequest,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";

const MAX_PROVIDER_EVENTS = 500;

export const CodingAgentProviderResumeStateSchema = z.object({
  conversationId: z.string().trim().min(1).max(512),
  providerThreadId: z.string().trim().min(1).max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/)
    .optional(),
}).strict();

export const CodingAgentProviderEventBatchSchema = z.object({
  events: z.array(AgentThreadEventSchema).max(100)
    .superRefine((events, context) => {
      const ids = new Set<string>();
      for (const event of events) {
        if (ids.has(event.eventId)) {
          context.addIssue({ code: "custom", message: "Duplicate provider event id" });
          return;
        }
        ids.add(event.eventId);
      }
    }),
  providerThreadId: CodingAgentProviderResumeStateSchema.shape.providerThreadId,
}).strict();

const CodingAgentProviderRunResultSchema = z.object({
  events: z.array(AgentThreadEventSchema).max(MAX_PROVIDER_EVENTS),
  resumeState: CodingAgentProviderResumeStateSchema.optional(),
  outcome: z.enum(["completed", "failed", "aborted", "delivered"]).optional(),
}).strict();

export type CodingAgentProviderResumeState = z.infer<typeof CodingAgentProviderResumeStateSchema>;
export type CodingAgentProviderRunResult = z.infer<typeof CodingAgentProviderRunResultSchema>;
export type CodingAgentProviderEventBatch = z.infer<typeof CodingAgentProviderEventBatchSchema>;

export interface CodingAgentProviderAdapter {
  providerId: string;
  getSummary?(input: {
    principal: RequestPrincipal;
    now: () => Date;
    signal: AbortSignal;
  }): Promise<AgentProviderSummary> | AgentProviderSummary;
  healthCheck?(input: {
    principal: RequestPrincipal;
    now: () => Date;
    signal: AbortSignal;
  }): Promise<{ ok: boolean }> | { ok: boolean };
  buildSetupAction?(input: {
    principal: RequestPrincipal;
    now: () => Date;
    signal: AbortSignal;
  }): Promise<SafeSetupAction[]> | SafeSetupAction[];
  startThread(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    request: CreateAgentThreadRequest;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<AgentThreadEvent[] | CodingAgentProviderRunResult> | AgentThreadEvent[] | CodingAgentProviderRunResult;
  resumeTurn?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    turn: {
      turnId: string;
      message: string;
      attachments?: CreateAgentTurnRequest["attachments"];
    };
    resumeState: CodingAgentProviderResumeState;
    signal: AbortSignal;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<CodingAgentProviderRunResult> | CodingAgentProviderRunResult;
  abortThread?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    clientRequestId: string;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<AgentThreadEvent[]> | AgentThreadEvent[];
  submitApproval?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    approvalId: string;
    request: ApprovalDecisionRequest;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<AgentThreadEvent[]> | AgentThreadEvent[];
  submitInput?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    inputRequestId: string;
    request: UserInputAnswerRequest;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<AgentThreadEvent[]> | AgentThreadEvent[];
}

export function parseCodingAgentProviderEvents(
  events: AgentThreadEvent[],
  threadId: string,
): AgentThreadEvent[] {
  const parsed = z.array(AgentThreadEventSchema).max(MAX_PROVIDER_EVENTS).parse(events);
  if (parsed.some((event) => event.threadId !== threadId)) {
    throw new Error("Provider emitted event for another thread");
  }
  if (parsed.some((event) => event.type === "user.message")) {
    throw new Error("Provider cannot emit user messages");
  }
  return parsed;
}

function providerMayEmit(event: AgentThreadEvent): boolean {
  switch (event.type) {
    case "thread.status":
    case "assistant.text.delta":
    case "assistant.text.completed":
    case "tool.started":
    case "tool.output":
    case "tool.completed":
    case "approval.requested":
    case "user_input.requested":
    case "file.changed":
    case "review.ready":
    case "thread.error":
    case "thread.completed":
      return true;
    default:
      return false;
  }
}

export function parseCodingAgentProviderEventBatch(
  batch: CodingAgentProviderEventBatch,
  threadId: string,
): CodingAgentProviderEventBatch {
  const parsed = CodingAgentProviderEventBatchSchema.parse(batch);
  const events = parseCodingAgentProviderEvents(parsed.events, threadId);
  if (events.some((event) => !providerMayEmit(event))) {
    throw new Error("Provider emitted reserved lifecycle event");
  }
  return { ...parsed, events };
}

export function parseCodingAgentProviderRunResult(
  result: AgentThreadEvent[] | CodingAgentProviderRunResult,
  threadId: string,
): CodingAgentProviderRunResult {
  const parsed = Array.isArray(result)
    ? CodingAgentProviderRunResultSchema.parse({ events: result })
    : CodingAgentProviderRunResultSchema.parse(result);
  return {
    ...parsed,
    events: parseCodingAgentProviderEvents(parsed.events, threadId),
  };
}
