import { z } from "zod/v4";

const RequestIdSchema = z.string().uuid();
const ProfileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const ScopeHandleSchema = z.string().regex(/^scope_[a-f0-9]{32}$/);
export const RuntimeHandleSchema = z.string().regex(/^runtime_[a-f0-9]{32}$/);
const AdapterIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SemanticVersionSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);
const GenerationSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
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
  workloads: z.array(z.enum(["chat_ai", "terminal"])).min(1).max(2),
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
  workload: z.enum(["chat_ai", "terminal"]),
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

export const ScopeRuntimeRequestSchema = z.discriminatedUnion("type", [
  CapabilityRequestSchema,
  RuntimeCreateRequestSchema,
  RuntimeStopRequestSchema,
  RuntimeChatRequestSchema,
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
    workloads: z.array(z.enum(["chat_ai", "terminal"])).min(1).max(2),
  }).strict()).min(1).max(16),
  sandbox: SandboxCapabilitySchema.optional(),
}).strict();

const CapabilityResultSchema = z.object({
  version: z.literal(1),
  type: z.literal("capability.result"),
  requestId: RequestIdSchema,
  ok: z.literal(true),
  supervisorVersion: SemanticVersionSchema,
  profile: CapabilityProfileSchema,
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

export const ScopeRuntimeResponseSchema = z.union([
  CapabilityResultSchema,
  CapabilityErrorSchema,
  RuntimeResultSchema,
  RuntimeErrorSchema,
  RuntimeChatResultSchema,
  RuntimeChatErrorSchema,
]);

export type ScopeRuntimeRequest = z.infer<typeof ScopeRuntimeRequestSchema>;
export type ScopeRuntimeResponse = z.infer<typeof ScopeRuntimeResponseSchema>;
export type ScopeRuntimeCapabilityProfile = z.infer<typeof CapabilityProfileSchema>;
