import {
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

const SafeProviderRefSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

export const CanonicalProviderRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("assistant.delta"),
    messageId: SafeProviderRefSchema.optional(),
    delta: z.string().min(1).max(4_000),
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
  }).strict(),
  z.object({ type: z.literal("state.updated"), state: z.unknown() }).strict(),
  z.object({
    type: z.literal("run.completed"),
    outcome: z.enum(["completed", "failed", "aborted"]),
    error: CanonicalChatSafeErrorSchema.optional(),
  }).strict(),
]);

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
  signal: AbortSignal;
}

export interface CanonicalChatProviderAdapter<State = unknown> {
  readonly driverKind: CanonicalProviderDriverKind;
  readonly stateSchemaVersion: number;
  parseState(value: unknown): State;
  serializeState(value: State): unknown;
  start(input: CanonicalProviderRunInput<State>): AsyncIterable<CanonicalProviderRunEvent>;
  resume?(input: CanonicalProviderRunInput<State> & { resumeState: State }): AsyncIterable<CanonicalProviderRunEvent>;
  cancel?(input: { owner: CanonicalOwnerScope; chatId: string; runId: string; state?: State }): Promise<void>;
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
