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
