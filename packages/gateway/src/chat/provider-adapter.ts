import {
  UserInputQuestionListSchema,
  AgentAttachmentSchema,
  ProtectedToolOutputSchema,
  type CanonicalSubmitChatInputRequest,
  CanonicalChatAgentActivityPayloadSchema,
  CanonicalChatApprovalDecisionSchema,
  CanonicalChatMessagePartSchema,
  CanonicalChatModelSelectionSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatMessagePart,
  type CanonicalChatApprovalDecision,
  type CanonicalChatModelSelection,
  type CanonicalChatSafeError,
  type CanonicalOwnerScope,
  type CanonicalProviderDriverKind,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { AiTokenUsageSchema } from "../ai-analytics.js";

const SafeProviderRefSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

export const CanonicalProviderRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("assistant.delta"),
    messageId: SafeProviderRefSchema.optional(),
    delta: z.string().min(1).max(4_000),
  }).strict(),
  z.object({
    type: z.literal("assistant.attachment"),
    attachment: AgentAttachmentSchema,
  }).strict(),
  CanonicalChatAgentActivityPayloadSchema.extend({
    type: z.literal("agent.activity"),
  }).strict(),
  z.object({
    type: z.literal("tool.progress"),
    toolCallId: SafeProviderRefSchema,
    label: z.string().trim().min(1).max(240),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  }).strict(),
  z.object({
    type: z.literal("tool.output"),
    toolCallId: SafeProviderRefSchema,
    text: z.string().max(4_000),
    protectedOutput: ProtectedToolOutputSchema.optional(),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("terminal.bound"),
    terminalSessionId: SafeProviderRefSchema,
    terminalSessionCreatedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    type: z.literal("review.ready"),
    reviewId: SafeProviderRefSchema,
    summary: z.object({
      changedFileCount: z.number().int().min(0).max(10_000),
      additions: z.number().int().min(0).max(1_000_000),
      deletions: z.number().int().min(0).max(1_000_000),
      partial: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("resource.changed"),
    resourceId: SafeProviderRefSchema,
    resourceKind: z.enum(["file", "folder", "project", "task", "app", "terminal_session"]),
    changeKind: z.enum(["created", "updated", "deleted", "renamed"]),
  }).strict(),
  z.object({
    type: z.literal("approval.requested"),
    approvalId: SafeProviderRefSchema,
    title: z.string().trim().min(1).max(160),
    risk: z.enum(["low", "medium", "high"]),
    allowedDecisions: z.array(CanonicalChatApprovalDecisionSchema).min(1).max(4),
  }).strict(),
  z.object({
    type: z.literal("approval.resolved"),
    approvalId: SafeProviderRefSchema,
    decision: CanonicalChatApprovalDecisionSchema,
  }).strict(),
  z.object({
    type: z.literal("input.requested"),
    requestId: SafeProviderRefSchema,
    title: z.string().trim().min(1).max(160),
    questions: UserInputQuestionListSchema.optional(),
    safeDescription: z.string().trim().min(1).max(600).optional(),
    expiresAt: z.iso.datetime().optional(),
    asynchronous: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("input.resolved"), requestId: SafeProviderRefSchema, reason: z.enum(["answered", "cancelled", "expired"]).optional() }).strict(),
  z.object({ type: z.literal("state.updated"), state: z.unknown() }).strict(),
  z.object({
    type: z.literal("run.completed"),
    outcome: z.enum(["completed", "failed", "aborted"]),
    error: CanonicalChatSafeErrorSchema.optional(),
    provider: SafeProviderRefSchema.optional(),
    tokenUsage: AiTokenUsageSchema.optional(),
  }).strict(),
]);

export const RecoveredControlActivitySchema = z.union([
  CanonicalProviderRunEventSchema,
  z.object({ type: z.literal("input.resolved"), requestId: SafeProviderRefSchema }).strict(),
]).transform((event, ctx) => {
  if (event.type === "approval.requested" || event.type === "approval.resolved" || event.type === "input.requested" || event.type === "input.resolved") return event;
  ctx.addIssue({ code: "custom", message: "Unsupported recovery control" });
  return z.NEVER;
});
export type RecoveredControlActivity = z.infer<typeof RecoveredControlActivitySchema>;

export type CanonicalProviderRunEvent = z.infer<typeof CanonicalProviderRunEventSchema>;

export interface CanonicalProviderRunInput<State = unknown> {
  owner: CanonicalOwnerScope;
  chatId: string;
  turnId: string;
  runId: string;
  prompt: string;
  parts: CanonicalChatMessagePart[];
  selection: CanonicalChatModelSelection;
  interactionMode: string;
  permissionMode: string;
  executionRoot?: string;
  projectSlug?: string;
  worktreeId?: string;
  resumeState?: State;
  /** Unique native admission identity for a continuation of the same canonical Run. */
  continuationId?: string;
  signal: AbortSignal;
  /** Generator return() errors can be masked by a consumer throw; report unresolved cleanup explicitly. */
  onCleanupUnconfirmed?: () => void;
  /** Clear unresolved cleanup only after this exact owned execution has exited. */
  onCleanupConfirmed?: () => void;
}

export interface CanonicalChatProviderAdapter<State = unknown> {
  readonly driverKind: CanonicalProviderDriverKind;
  readonly stateSchemaVersion: number;
  /** Native execution survives a gateway restart; detach only after identity is durable. */
  readonly detachOnShutdown?: boolean;
  parseState(value: unknown): State;
  serializeState(value: State): unknown;
  /** Read-only admission guard for adapters whose execution can outlive projection. */
  isBackingRunActive?(input: { owner: CanonicalOwnerScope; state: State; signal: AbortSignal }): Promise<boolean>;
  /** Read-only recovery of this exact Run; never starts or resubmits work. */
  recover?(input: {
    owner: CanonicalOwnerScope;
    runId: string;
    state: State;
    signal: AbortSignal;
  }): Promise<{
    outcome: "completed" | "failed" | "aborted" | "pending";
    messages: Array<{ messageId?: string; text: string }>;
    activities?: RecoveredControlActivity[];
  } | null>;
  start(input: CanonicalProviderRunInput<State>): AsyncIterable<CanonicalProviderRunEvent>;
  resume?(input: CanonicalProviderRunInput<State> & { resumeState: State }): AsyncIterable<CanonicalProviderRunEvent>;
  cancel?(input: { owner: CanonicalOwnerScope; chatId: string; runId: string; state?: State }): Promise<void>;
  steer?(input: {
    owner: CanonicalOwnerScope;
    chatId: string;
    runId: string;
    turnId: string;
    clientRequestId: string;
    prompt: string;
    parts: CanonicalChatMessagePart[];
    state?: State;
  }): Promise<void>;
  submitInput?(input: CanonicalSubmitChatInputRequest & { owner: CanonicalOwnerScope; chatId: string; runId: string; requestId: string; state?: State }): Promise<void | "queued">;
  /** Internal acknowledgement only: the user has NOT answered or authorized anything. */
  deferInput?(input: { owner: CanonicalOwnerScope; chatId: string; runId: string; requestId: string }): Promise<void>;
  submitApproval?(input: {
    owner: CanonicalOwnerScope;
    chatId: string;
    runId: string;
    approvalId: string;
    decision: CanonicalChatApprovalDecision;
    clientRequestId: string;
    state?: State;
  }): Promise<void>;
}

export function parseCanonicalProviderRunInput<State>(
  input: CanonicalProviderRunInput<State>,
): CanonicalProviderRunInput<State> {
  CanonicalOwnerScopeSchema.parse(input.owner);
  CanonicalChatModelSelectionSchema.parse(input.selection);
  z.array(CanonicalChatMessagePartSchema).min(1).max(64).parse(input.parts);
  z.string().min(1).max(96 * 1024).parse(input.prompt);
  return input;
}

export class CanonicalChatProviderRegistry {
  private readonly adapters = new Map<CanonicalProviderDriverKind, CanonicalChatProviderAdapter>();

  constructor(adapters: readonly CanonicalChatProviderAdapter[]) {
    if (adapters.length > 20) throw new RangeError("Too many canonical Chat Provider adapters");
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.driverKind)) {
        throw new Error("Duplicate canonical Chat Provider adapter");
      }
      this.adapters.set(adapter.driverKind, adapter);
    }
  }

  get(driverKind: CanonicalProviderDriverKind): CanonicalChatProviderAdapter | undefined {
    return this.adapters.get(driverKind);
  }
}

export function providerFailure(error: CanonicalChatSafeError): CanonicalProviderRunEvent {
  return CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: "failed", error });
}
