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
}).strict();

const CodingAgentProviderRunResultSchema = z.object({
  events: z.array(AgentThreadEventSchema).max(MAX_PROVIDER_EVENTS),
  resumeState: CodingAgentProviderResumeStateSchema.optional(),
  outcome: z.enum(["completed", "failed", "aborted", "delivered"]).optional(),
}).strict();

export type CodingAgentProviderResumeState = z.infer<typeof CodingAgentProviderResumeStateSchema>;
export type CodingAgentProviderRunResult = z.infer<typeof CodingAgentProviderRunResultSchema>;

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
  return parsed;
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
