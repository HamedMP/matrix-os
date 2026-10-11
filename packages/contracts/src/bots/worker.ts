import { MatrixComputerRuntimeSlotSchema } from "#contract-primitives";
import { z } from "zod/v4";
import { canonicalEncodedByteLength } from "#canonical-chat-primitives";
import { BOT_IMAGE_MAX_BASE64_CHARS, BotToolCapabilitySchema, BotToolErrorCodeSchema } from "#bots/broker";
import { BotBlockedReasonSchema } from "#bots/tasks";

/** Model route resolved by the gateway from Provider V3; the worker never chooses one. */
export const BotModelRouteSchema = z.object({
  api: z.enum(["anthropic-messages", "openai-responses", "openai-completions"]),
  modelId: z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,127}$/),
  input: z.array(z.enum(["text", "image"])).min(1).max(2)
    .refine((input) => input.includes("text"), { message: "Routes must accept text" }),
  contextWindow: z.number().int().min(8_192).max(2_000_000),
  /** Bounded so one buffered bridge response stays under the broker's 512 KiB cap. */
  maxOutputTokens: z.number().int().min(256).max(16_384),
}).strict();

export const BotImageInputSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(BOT_IMAGE_MAX_BASE64_CHARS),
}).strict();

/** Server composition only; never a Chat selection option or owner profile. */
export const IsolatedChatEnvelopeSchema = z.object({
  phaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
  ownerId: z.string().min(1).max(160), machineId: z.string().min(1).max(160),
  runtimeSlot: MatrixComputerRuntimeSlotSchema,
  runtimeTokenEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  runtimeCredentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
  chatId: z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/),
  modelId: z.enum(["@cf/zai-org/glm-5.3-flash", "anthropic/claude-sonnet-5"]),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  startsAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.startsAt)
  && Date.parse(value.expiresAt) - Date.parse(value.startsAt) <= 60 * 60_000,
{ message: "Invalid isolated phase lifetime" });
/** Only server composition calls this; partial configuration never enables a fallback. */
export function parseIsolatedChatEnvelope(raw: string | undefined): IsolatedChatEnvelope | undefined {
  if (raw === undefined) return undefined;
  try {
    if (raw.length > 4096) throw new Error("Too large");
    return IsolatedChatEnvelopeSchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    console.warn("[isolated-chat] Invalid server configuration:", error instanceof Error ? error.name : "UnknownError");
    throw new Error("Isolated Chat server configuration is invalid");
  }
}
export type IsolatedChatEnvelope = z.infer<typeof IsolatedChatEnvelopeSchema>;
export function isolatedChatModelMatches(expected: IsolatedChatEnvelope["modelId"], candidate: string): boolean {
  return expected === candidate || (expected === "anthropic/claude-sonnet-5" && candidate === "claude-sonnet-5");
}

/** Worker instruction only. Gateway retains the authoritative phase/run fence. */
export const IsolatedBotTurnSchema = z.object({
  phaseId: IsolatedChatEnvelopeSchema.shape.phaseId,
  maxInputBytes: z.literal(131072),
}).strict();

export const BotRunLimitsSchema = z.object({
  maxToolActions: z.number().int().min(1).max(60),
}).strict();

const RunIdSchema = z.string().regex(/^run_[A-Za-z0-9_-]{1,128}$/);
const SystemPromptSchema = z.string().min(1).max(32 * 1024);
const CapabilitiesSchema = z.array(BotToolCapabilitySchema).max(16)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length, { message: "Capabilities must be unique" });
const PromptTextSchema = z.string().min(1).max(64 * 1024);

/**
 * What a `bot_agent` worker loads from the broker when the supervisor relays
 * `bot.run { runId }`. Images stay on the gateway and are read in chunks with
 * `bot.input.image`, so neither the supervisor nor any single frame carries them.
 */
export const BotRunSpecSchema = z.object({
  route: BotModelRouteSchema,
  systemPrompt: SystemPromptSchema,
  capabilities: CapabilitiesSchema,
  limits: BotRunLimitsSchema,
  isolatedTurn: IsolatedBotTurnSchema.optional(),
  turn: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("prompt"), text: PromptTextSchema, imageCount: z.number().int().min(0).max(4).optional() }).strict(),
    z.object({ kind: z.literal("continue") }).strict(),
  ]),
}).strict().refine((spec) => canonicalEncodedByteLength(spec) <= 160 * 1024, { message: "Run is too large" });

export const BotWorkerCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("bot.run"),
    runId: RunIdSchema,
    route: BotModelRouteSchema,
    systemPrompt: SystemPromptSchema,
    capabilities: CapabilitiesSchema,
    limits: BotRunLimitsSchema,
  isolatedTurn: IsolatedBotTurnSchema.optional(),
    turn: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("prompt"),
        text: PromptTextSchema,
        images: z.array(BotImageInputSchema).max(4).optional(),
      }).strict(),
      z.object({ kind: z.literal("continue") }).strict(),
    ]),
  }).strict().refine((command) => canonicalEncodedByteLength(command) <= 12 * 1024 * 1024, { message: "Command is too large" }),
  z.object({ version: z.literal(1), kind: z.literal("bot.steer"), runId: RunIdSchema, text: z.string().min(1).max(8 * 1024) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("bot.cancel"), runId: RunIdSchema }).strict(),
]);

export const BotRunStatusSchema = z.enum([
  "completed",
  "waiting_person",
  "waiting_capacity",
  "blocked",
  "failed",
  "cancelled",
  "uncertain",
]);

export const BotRunOutcomeSchema = z.object({
  runId: RunIdSchema,
  status: BotRunStatusSchema,
  blockedReason: BotBlockedReasonSchema.optional(),
  /** Set on `failed`, and on `uncertain` when the transcript could not be saved afterwards. */
  failureCode: BotToolErrorCodeSchema.optional(),
  /** Absent when the session could not be loaded, so nothing was read or written. */
  sessionRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  toolActions: z.number().int().min(0).max(60),
}).strict();

export type BotModelRoute = z.infer<typeof BotModelRouteSchema>;
export type BotImageInput = z.infer<typeof BotImageInputSchema>;
export type BotWorkerCommand = z.infer<typeof BotWorkerCommandSchema>;
export type BotRunCommand = Extract<BotWorkerCommand, { kind: "bot.run" }>;
export type BotRunSpec = z.infer<typeof BotRunSpecSchema>;
export type BotRunStatus = z.infer<typeof BotRunStatusSchema>;
export type BotRunOutcome = z.infer<typeof BotRunOutcomeSchema>;
