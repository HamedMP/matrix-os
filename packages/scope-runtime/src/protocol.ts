import { z } from "zod/v4";

const RequestIdSchema = z.string().uuid();
const ProfileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const ScopeHandleSchema = z.string().regex(/^scope_[a-f0-9]{32}$/);
export const RuntimeHandleSchema = z.string().regex(/^runtime_[a-f0-9]{32}$/);
const AdapterIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SemanticVersionSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);
const GenerationSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ScopeRuntimeWorkloadSchema = z.enum(["chat_ai", "terminal", "bot_agent"]);
const WorkloadListSchema = z.array(ScopeRuntimeWorkloadSchema).min(1).max(3);
const BotRunIdSchema = z.string().regex(/^run_[A-Za-z0-9_-]{1,128}$/);
const MAX_BOT_REPLY_BYTES = 16 * 1024;
const BoundedPromptSchema = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= 64 * 1024,
  "Prompt exceeds scope runtime limit",
);

/** Fixed profile ceilings; a sandbox manifest may only narrow them. */
export const SCOPE_RUNTIME_PROFILE_LIMITS = Object.freeze({
  memoryMaxBytes: 1_073_741_824,
  cpuQuotaPercent: 200,
  tasksMax: 256,
});

const SandboxActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const SandboxHostPathSchema = z.string().min(2).max(4_096).refine((value) =>
  value.startsWith("/") && !value.includes("\0") && !value.includes("\n") && !value.includes("\r")
  && !value.includes(":") && !value.split("/").includes("..") && !value.endsWith("/"),
  "Invalid sandbox host path");

/**
 * S07 / T036: actor/scope/worktree mount manifest for a sandboxed run.
 * Strict, prompt-independent, and never wider than the fixed profile.
 */
export const ScopeRuntimeSandboxManifestSchema = z.object({
  version: z.literal(1),
  scopeHandle: ScopeHandleSchema,
  actorId: SandboxActorIdSchema,
  worktree: z.object({
    hostPath: SandboxHostPathSchema,
    mode: z.enum(["ro", "rw"]),
    fingerprint: DigestSchema,
  }).strict(),
  network: z.enum(["none", "broker_only"]),
  limits: z.object({
    memoryMaxBytes: z.number().int().min(64 * 1024 * 1024).max(SCOPE_RUNTIME_PROFILE_LIMITS.memoryMaxBytes),
    cpuQuotaPercent: z.number().int().min(1).max(SCOPE_RUNTIME_PROFILE_LIMITS.cpuQuotaPercent),
    tasksMax: z.number().int().min(8).max(SCOPE_RUNTIME_PROFILE_LIMITS.tasksMax),
  }).strict().optional(),
}).strict();

export type ScopeRuntimeSandboxManifest = z.infer<typeof ScopeRuntimeSandboxManifestSchema>;

const SandboxCapabilitySchema = z.object({
  policyVersion: z.number().int().min(1).max(1_000_000),
  policyDigest: DigestSchema,
  workloads: WorkloadListSchema,
}).strict();

const CapabilityRequestSchema = z.object({
  version: z.literal(1),
  type: z.literal("capability.get"),
  requestId: RequestIdSchema,
}).strict();

const RuntimeCreateRequestSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.create"),
  requestId: RequestIdSchema,
  scopeHandle: ScopeHandleSchema,
  profileId: ProfileIdSchema,
  workload: ScopeRuntimeWorkloadSchema,
  adapterId: AdapterIdSchema,
  harnessVersion: SemanticVersionSchema,
  sandbox: ScopeRuntimeSandboxManifestSchema.optional(),
}).strict();

const RuntimeStopRequestSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.stop"),
  requestId: RequestIdSchema,
  runtimeHandle: RuntimeHandleSchema,
}).strict();

const RuntimeChatRequestSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.chat"),
  requestId: RequestIdSchema,
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  model: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/),
  prompt: BoundedPromptSchema,
}).strict();

/**
 * Bot commands relayed to a `bot_agent` worker. They carry identifiers and
 * steering text only: the worker loads the run itself (prompt, route,
 * capabilities, images) from the gateway broker, so the supervisor never
 * handles prompt content.
 */
export const ScopeRuntimeBotCommandSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("bot.run"), runId: BotRunIdSchema }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("bot.steer"),
    runId: BotRunIdSchema,
    text: z.string().min(1).max(8 * 1024),
  }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("bot.cancel"), runId: BotRunIdSchema }).strict(),
]);

const RuntimeBotRequestSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.bot"),
  requestId: RequestIdSchema,
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  command: ScopeRuntimeBotCommandSchema,
}).strict();

export const ScopeRuntimeRequestSchema = z.discriminatedUnion("type", [
  CapabilityRequestSchema,
  RuntimeCreateRequestSchema,
  RuntimeStopRequestSchema,
  RuntimeChatRequestSchema,
  RuntimeBotRequestSchema,
]);

/** The worker's reply is opaque here and validated by the gateway against the bot contracts. */
const BotReplySchema = z.record(z.string(), z.unknown())
  .refine((reply) => Buffer.byteLength(JSON.stringify(reply), "utf8") <= MAX_BOT_REPLY_BYTES, "Bot reply exceeds scope runtime limit");

/** Frames on a `bot_agent` worker's command socket, one request and one reply per connection. */
export const ScopeRuntimeBotWorkerReplySchema = z.discriminatedUnion("ok", [
  z.object({ version: z.literal(1), ok: z.literal(true), reply: BotReplySchema }).strict(),
  z.object({ version: z.literal(1), ok: z.literal(false), error: z.enum(["busy", "invalid_command", "unavailable"]) }).strict(),
]);

const RuntimeLimitsSchema = z.object({
  memoryMaxBytes: z.number().int().min(64 * 1024 * 1024).max(16 * 1024 * 1024 * 1024),
  cpuQuotaPercent: z.number().int().min(1).max(800),
  tasksMax: z.number().int().min(8).max(4096),
  storageMaxBytes: z.number().int().min(64 * 1024 * 1024).max(1024 * 1024 * 1024 * 1024),
}).strict();

const CapabilityProfileSchema = z.object({
  profileId: ProfileIdSchema,
  profileVersion: z.number().int().min(1).max(1_000_000),
  profileDigest: DigestSchema,
  executionGeneration: GenerationSchema,
  identity: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("dynamic"),
      uidMin: z.number().int().min(0).max(4_294_967_294),
      uidMax: z.number().int().min(0).max(4_294_967_294),
    }).strict(),
    z.object({
      mode: z.literal("static"),
      uid: z.number().int().min(0).max(4_294_967_294),
    }).strict(),
  ]),
  limits: RuntimeLimitsSchema,
  adapters: z.array(z.object({
    adapterId: AdapterIdSchema,
    harnessVersion: SemanticVersionSchema,
    workloads: WorkloadListSchema,
  }).strict()).min(1).max(16),
  sandbox: SandboxCapabilitySchema.optional(),
}).strict();

const CapabilityResultSchema = z.object({
  version: z.literal(1),
  type: z.literal("capability.result"),
  requestId: RequestIdSchema,
  ok: z.literal(true),
  supervisorVersion: SemanticVersionSchema,
  /** The shared-chat profile, kept for gateways that predate the catalog. */
  profile: CapabilityProfileSchema,
  /** Every launchable profile, the shared-chat profile included. */
  profiles: z.array(CapabilityProfileSchema).min(1).max(4)
    .refine((profiles) => new Set(profiles.map((entry) => entry.profileId)).size === profiles.length, "Duplicate profile")
    .optional(),
}).strict();

const CapabilityErrorSchema = z.object({
  version: z.literal(1),
  type: z.literal("capability.result"),
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: z.enum(["invalid_request", "profile_unavailable", "runtime_unavailable"]),
}).strict();

const RuntimeResultSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.result"),
  requestId: RequestIdSchema,
  ok: z.literal(true),
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  state: z.enum(["running", "stopped"]),
}).strict();

const RuntimeErrorSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.result"),
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: z.enum([
    "invalid_request",
    "profile_unavailable",
    "adapter_unavailable",
    "capacity_exceeded",
    "runtime_not_found",
    "runtime_unavailable",
  ]),
}).strict();

const RuntimeChatResultSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.chat.result"),
  requestId: RequestIdSchema,
  ok: z.literal(true),
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  text: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= 96 * 1024,
    "Response exceeds scope runtime limit",
  ),
}).strict();

const RuntimeChatErrorSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.chat.result"),
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: z.enum([
    "invalid_request",
    "runtime_not_found",
    "runtime_unavailable",
    "generation_mismatch",
  ]),
}).strict();

const RuntimeBotResultSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.bot.result"),
  requestId: RequestIdSchema,
  ok: z.literal(true),
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  reply: BotReplySchema,
}).strict();

const RuntimeBotErrorSchema = z.object({
  version: z.literal(1),
  type: z.literal("runtime.bot.result"),
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: z.enum([
    "invalid_request",
    "runtime_not_found",
    "runtime_unavailable",
    "generation_mismatch",
    "busy",
  ]),
}).strict();

export const ScopeRuntimeResponseSchema = z.union([
  CapabilityResultSchema,
  CapabilityErrorSchema,
  RuntimeResultSchema,
  RuntimeErrorSchema,
  RuntimeChatResultSchema,
  RuntimeChatErrorSchema,
  RuntimeBotResultSchema,
  RuntimeBotErrorSchema,
]);

export type ScopeRuntimeRequest = z.infer<typeof ScopeRuntimeRequestSchema>;
export type ScopeRuntimeResponse = z.infer<typeof ScopeRuntimeResponseSchema>;
export type ScopeRuntimeCapabilityProfile = z.infer<typeof CapabilityProfileSchema>;
export type ScopeRuntimeWorkload = z.infer<typeof ScopeRuntimeWorkloadSchema>;
export type ScopeRuntimeBotCommand = z.infer<typeof ScopeRuntimeBotCommandSchema>;
export type ScopeRuntimeBotWorkerReply = z.infer<typeof ScopeRuntimeBotWorkerReplySchema>;
