// Native frame validation shared by the plain Node runner; this module owns no Matrix authority.
import { z } from "zod/v4";
const MAX_LINE_BYTES = 64 * 1024;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;

const NativeRequestIdSchema = z.union([z.string().min(1).max(128), z.number().int().safe()]);
export const NativeReferenceSchema = z.string().min(1).max(512);
const ApprovalMethodSchema = z.enum([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const NativeApprovalDecisionSchema = z.union([
  z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  z.object({
    acceptWithExecpolicyAmendment: z.object({
      execpolicy_amendment: z.array(z.string().max(4000)).max(128),
    }).strict(),
  }).strict(),
  z.object({
    applyNetworkPolicyAmendment: z.object({
      network_policy_amendment: z.object({
        action: z.enum(["allow", "deny"]),
        host: z.string().min(1).max(255),
      }).strict(),
    }).strict(),
  }).strict(),
]);
const NativeApprovalDecisionListSchema = z.array(z.unknown()).max(16).transform((decisions) =>
  decisions.flatMap((decision) => {
    const parsed = NativeApprovalDecisionSchema.safeParse(decision);
    return parsed.success ? [parsed.data] : [];
  }));
export const ApprovalRequestSchema = z.object({
  id: NativeRequestIdSchema,
  method: ApprovalMethodSchema,
  params: z.object({
    threadId: NativeReferenceSchema,
    turnId: NativeReferenceSchema,
    itemId: NativeReferenceSchema,
    availableDecisions: NativeApprovalDecisionListSchema.nullable().optional(),
  }).passthrough(),
}).passthrough();
const DisplayTextSchema = z.string()
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value));
const NativeQuestionSchema = z.object({
  id: z.string().min(1).max(128),
  header: DisplayTextSchema.min(1).max(160),
  question: DisplayTextSchema.min(1).max(2400),
  options: z.array(z.object({
    label: DisplayTextSchema.min(1).max(160),
    description: DisplayTextSchema.min(1).max(1200),
  }).passthrough()).min(1).max(10).nullable().optional(),
  isOther: z.boolean().default(false),
  isSecret: z.boolean().default(false),
}).passthrough();
export const InputRequestSchema = z.object({
  id: NativeRequestIdSchema,
  method: z.literal("item/tool/requestUserInput"),
  params: z.object({
    threadId: NativeReferenceSchema,
    turnId: NativeReferenceSchema,
    itemId: NativeReferenceSchema,
    autoResolutionMs: z.number().int().min(0).max(240_000).nullable().optional(),
    questions: z.array(NativeQuestionSchema).min(1).max(8),
  }).passthrough(),
}).passthrough();
export const AgentDeltaSchema = z.object({
  method: z.literal("item/agentMessage/delta"),
  params: z.object({
    turnId: NativeReferenceSchema,
    itemId: NativeReferenceSchema,
    delta: z.string().max(MAX_LINE_BYTES),
  }).passthrough(),
}).passthrough();
export const ToolOutputDeltaSchema = z.object({
  method: z.enum([
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/mcpToolCall/progress",
    "item/dynamicToolCall/outputDelta",
  ]),
  params: z.object({
    turnId: NativeReferenceSchema,
    itemId: NativeReferenceSchema,
  }).passthrough(),
}).passthrough();
const MessagePhaseSchema = z.enum(["commentary", "partial_answer", "final_answer"]);
export const ToolLifecycleTypeSchema = z.enum([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "plan",
  "reasoning",
  "imageGeneration",
]);
const AgentMessageLifecycleItemSchema = z.object({
  id: NativeReferenceSchema,
  type: z.literal("agentMessage"),
  text: z.string().max(MAX_PROVIDER_LINE_BYTES),
  phase: MessagePhaseSchema.nullable().optional(),
}).passthrough();
const ToolLifecycleItemSchema = z.object({
  id: NativeReferenceSchema,
  type: ToolLifecycleTypeSchema,
  server: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
  tool: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
  status: z.string().max(80).optional(),
  command: z.string().max(MAX_PROVIDER_LINE_BYTES).optional(),
  cwd: z.string().max(4_096).optional(),
  changes: z.array(z.object({
    path: z.string().min(1).max(4_096),
  }).passthrough()).max(200).optional(),
  aggregatedOutput: z.string().max(MAX_PROVIDER_LINE_BYTES).nullable().optional(),
  result: z.unknown().nullable().optional(),
  error: z.unknown().nullable().optional(),
}).passthrough();
const IgnoredLifecycleItemSchema = z.object({
  id: NativeReferenceSchema,
  type: z.string().min(1).max(80).refine((type) => (
    type !== "agentMessage" && !ToolLifecycleTypeSchema.options.includes(type)
  )),
}).passthrough();
const LifecycleItemSchema = z.union([
  AgentMessageLifecycleItemSchema,
  ToolLifecycleItemSchema,
  IgnoredLifecycleItemSchema,
]);
export const ItemLifecycleSchema = z.object({
  method: z.enum(["item/started", "item/completed"]),
  params: z.object({
    turnId: NativeReferenceSchema,
    item: LifecycleItemSchema,
  }).passthrough(),
}).passthrough();
export const TurnCompletedSchema = z.object({
  method: z.literal("turn/completed"),
  params: z.object({
    turn: z.object({
      status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    }).passthrough(),
  }).passthrough(),
}).passthrough();
const TokenUsageBreakdownSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reasoningOutputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).passthrough();
export const TokenUsageUpdatedSchema = z.object({
  method: z.literal("thread/tokenUsage/updated"),
  params: z.object({
    threadId: NativeReferenceSchema,
    turnId: NativeReferenceSchema,
    tokenUsage: z.object({
      last: TokenUsageBreakdownSchema,
    }).passthrough(),
  }).passthrough(),
}).passthrough();
export const RpcResponseSchema = z.object({
  id: NativeRequestIdSchema,
  result: z.unknown().optional(),
  error: z.unknown().optional(),
}).passthrough();
export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string().max(512),
}).passthrough();
