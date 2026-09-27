import { z } from "zod/v4";
import { canonicalEncodedByteLength } from "#canonical-chat-primitives";
import { BotToolCapabilitySchema, BotToolErrorCodeSchema } from "#bots/broker";
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
  data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(Math.ceil((2 * 1024 * 1024) / 3) * 4),
}).strict();

export const BotRunLimitsSchema = z.object({
  maxToolActions: z.number().int().min(1).max(60),
}).strict();

const RunIdSchema = z.string().regex(/^run_[A-Za-z0-9_-]{1,128}$/);

export const BotWorkerCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("bot.run"),
    runId: RunIdSchema,
    route: BotModelRouteSchema,
    systemPrompt: z.string().min(1).max(32 * 1024),
    capabilities: z.array(BotToolCapabilitySchema).max(16)
      .refine((capabilities) => new Set(capabilities).size === capabilities.length, { message: "Capabilities must be unique" }),
    limits: BotRunLimitsSchema,
    turn: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("prompt"),
        text: z.string().min(1).max(64 * 1024),
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
  failureCode: BotToolErrorCodeSchema.optional(),
  sessionRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  toolActions: z.number().int().min(0).max(60),
}).strict();

export type BotModelRoute = z.infer<typeof BotModelRouteSchema>;
export type BotImageInput = z.infer<typeof BotImageInputSchema>;
export type BotWorkerCommand = z.infer<typeof BotWorkerCommandSchema>;
export type BotRunCommand = Extract<BotWorkerCommand, { kind: "bot.run" }>;
export type BotRunStatus = z.infer<typeof BotRunStatusSchema>;
export type BotRunOutcome = z.infer<typeof BotRunOutcomeSchema>;
