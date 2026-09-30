import { BackgroundAgentRefSchema } from "../background-agent-runtime.js";
import { z } from "zod/v4";
import {
  AgentThreadEventSchema,
  CanonicalChatRunPolicySchema,
  CanonicalOwnerScopeSchema,
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
import { AiTokenUsageSchema } from "../ai-analytics.js";

const MAX_PROVIDER_EVENTS = 500;

/** Internal launch grant. Never add this schema to an HTTP/WS request contract. */
export const CodingAgentCanonicalExecutionSchema = z.object({
  executionPolicy: CanonicalChatRunPolicySchema.shape.executionPolicy.unwrap().refine(policy => !policy.delegation
    && (policy.actionMode !== "conversation_only" || policy.tools.length === 0)),
  inventory: z.array(z.object({
    toolId: z.enum(["matrix_list_apps", "matrix_inspect_app", "matrix_search_workspace", "matrix_open_app", "matrix_apply_app_files"]),
    schemaRevision: z.string().min(1).max(160), description: z.string().min(1).max(1600),
    effect: z.enum(["read", "navigation", "files"]), inputSchema: z.unknown(),
  }).strict()).max(32),
  identity: z.object({ owner: CanonicalOwnerScopeSchema, chatId: z.string().min(1).max(128), runId: z.string().min(1).max(128) }).strict(),
  authFile: z.string().max(4096).optional(),
}).strict();
export type CodingAgentCanonicalExecution = z.infer<typeof CodingAgentCanonicalExecutionSchema>;

/** Native continuation result, not approval/authorization; exact request binding is enforced in the child. */
export const CodingAgentCanonicalToolResultSchema = z.object({
  type: z.literal("canonical_tool_result"),
  actionId: z.string().regex(/^action_[a-f0-9]{32}$/),
  argumentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.object({ success: z.boolean(), contentItems: z.array(z.object({
    type: z.literal("inputText"), text: z.string().max(16_000),
  }).strict()).max(8) }).strict().refine(result => Buffer.byteLength(JSON.stringify(result)) <= 65_536),
}).strict();
export type CodingAgentCanonicalToolResult = z.infer<typeof CodingAgentCanonicalToolResultSchema>;

/** Internal live request, excluded from ordinary provider/user event projections. */
export const CodingAgentCanonicalActionRequestSchema = CodingAgentCanonicalExecutionSchema.shape.identity.extend({
  type: z.literal("matrix.codex.action.requested"),
  executionPolicy: CodingAgentCanonicalExecutionSchema.shape.executionPolicy,
  actionId: CodingAgentCanonicalToolResultSchema.shape.actionId,
  argumentDigest: CodingAgentCanonicalToolResultSchema.shape.argumentDigest,
  inventoryDigest: CodingAgentCanonicalToolResultSchema.shape.inventoryDigest,
  toolCallId: z.string().regex(/^codex_item_[a-f0-9]{32}$/),
  nativeThreadId: z.string().min(1).max(512), nativeTurnId: z.string().min(1).max(512), nativeCallId: z.string().min(1).max(512),
  toolId: CodingAgentCanonicalExecutionSchema.shape.inventory.element.shape.toolId,
  schemaRevision: z.string().min(1).max(160), arguments: z.unknown(),
}).strict();
export type CodingAgentCanonicalActionRequest = z.infer<typeof CodingAgentCanonicalActionRequestSchema>;

export const CodingAgentProviderResumeStateSchema = z.object({
  conversationId: z.string().trim().min(1).max(512),
  backgroundRef: BackgroundAgentRefSchema.optional(),
  eventOffset: z.number().int().min(0).max(16 * 1024 * 1024).optional(),
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
  resumeState: CodingAgentProviderResumeStateSchema.optional(),
  tokenUsage: AiTokenUsageSchema.optional(),
}).strict();

const CodingAgentProviderRunResultSchema = z.object({
  events: z.array(AgentThreadEventSchema).max(MAX_PROVIDER_EVENTS),
  resumeState: CodingAgentProviderResumeStateSchema.optional(),
  outcome: z.enum(["completed", "failed", "aborted", "delivered"]).optional(),
}).strict();

export type CodingAgentProviderResumeState = z.infer<typeof CodingAgentProviderResumeStateSchema>;
export type CodingAgentProviderRunResult = z.infer<typeof CodingAgentProviderRunResultSchema>;
export type CodingAgentProviderEventBatch = z.infer<typeof CodingAgentProviderEventBatchSchema>;
export type CodingAgentProviderEventPublisher = (
  batch: CodingAgentProviderEventBatch,
) => Promise<void>;

export interface CodingAgentProviderAdapter {
  providerId: string;
  /** Long-running initial executions are dispatched after durable thread creation. */
  initialRunExecution?: "background";
  /** Native service execution and uncertain delivery survive gateway shutdown. */
  backgroundExecution?: boolean;
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
    /** Internal canonical grant bound to this thread's isolated launch. Never client data. */
    canonicalExecution?: CodingAgentCanonicalExecution;
    signal?: AbortSignal;
    now: () => Date;
    nextEventId: () => string;
    publishEvents?: CodingAgentProviderEventPublisher;
  }): Promise<AgentThreadEvent[] | CodingAgentProviderRunResult> | AgentThreadEvent[] | CodingAgentProviderRunResult;
  resumeTurn?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    turn: {
      turnId: string;
      message: string;
      attachments?: CreateAgentTurnRequest["attachments"];
      model?: CreateAgentTurnRequest["model"];
      modelOptions?: CreateAgentTurnRequest["modelOptions"];
      approvalPolicy?: CreateAgentTurnRequest["approvalPolicy"];
      sandboxMode?: CreateAgentTurnRequest["sandboxMode"];
    };
    resumeState: CodingAgentProviderResumeState;
    signal: AbortSignal;
    now: () => Date;
    nextEventId: () => string;
    publishEvents?: CodingAgentProviderEventPublisher;
  }): Promise<CodingAgentProviderRunResult> | CodingAgentProviderRunResult;
  steerTurn?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    turnId?: string;
    message: string;
    clientRequestId: string;
    resumeState: CodingAgentProviderResumeState;
  }): Promise<void> | void;
  abortThread?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    clientRequestId: string;
    /** Automatic cleanup requires a stopped runtime, not merely an interrupt RPC acknowledgement. */
    requireRuntimeStop?: boolean;
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
  /** Internal OS acknowledgement; no user answer or permission is implied. */
  deferInput?(input: { principal: RequestPrincipal; thread: AgentThreadSummary; inputRequestId: string }): Promise<void> | void;
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
    case "approval.resolved":
      // Native expiry/turn shutdown can withdraw a request, never grant consent.
      // Other decisions remain reserved for the authenticated approval route.
      return event.decision === "cancel";
    case "thread.status":
    case "assistant.text.delta":
    case "assistant.text.completed":
    case "assistant.attachment":
    case "subagent.activity":
    case "tool.started":
    case "tool.output":
    case "tool.completed":
    case "approval.requested":
    case "user_input.requested":
    case "user_input.answered":
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
