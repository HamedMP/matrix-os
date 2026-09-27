import { z } from "zod/v4";
import { canonicalBoundedText, canonicalEncodedByteLength, canonicalOwnerRelativePath, canonicalReferenceId } from "#canonical-chat-primitives";
import { BotConnectionIdSchema, BotIntegrationServiceSchema } from "#bots/ids";
import { BotInteractionPayloadSchema } from "#bots/interactions";
import { BotMemoryContentSchema, BotMemoryKindSchema, BotMemoryScopeSchema, BotMemorySourceSchema } from "#bots/memory";

/** Leaves room for the broker envelope inside the 256 KiB broker request cap. */
export const BOT_ARTIFACT_MAX_BYTES = 192 * 1024;
const MAX_INTEGRATION_PARAMS_BYTES = 32 * 1024;
const MAX_SESSION_BYTES = 512 * 1024;
const MAX_TOOL_REQUEST_BYTES = 240 * 1024;

const ToolCallIdSchema = canonicalReferenceId(128);
const ArtifactPathSchema = canonicalOwnerRelativePath(256, 1_024);
const ArtifactMimeTypeSchema = z.enum(["text/markdown", "text/plain", "text/csv", "application/json", "text/html"]);
const textEncoder = new TextEncoder();

/** M1 capabilities. Later milestones add handoffs and computer actions. */
export const BotToolCapabilitySchema = z.enum([
  "integration.inventory",
  "integration.call",
  "memory.propose",
  "memory.search",
  "interaction.create",
  "artifact.write",
  "artifact.read",
]);

const capability = <Name extends z.infer<typeof BotToolCapabilitySchema>, Args extends z.ZodType>(name: Name, args: Args) => z.object({
  toolCallId: ToolCallIdSchema,
  capability: z.literal(name),
  args,
}).strict();

const BotToolRequestUnionSchema = z.discriminatedUnion("capability", [
  capability("integration.inventory", z.object({ service: BotIntegrationServiceSchema.optional() }).strict()),
  capability("integration.call", z.object({
    service: BotIntegrationServiceSchema,
    action: canonicalReferenceId(128),
    connectionId: BotConnectionIdSchema,
    params: z.record(z.string().min(1).max(128), z.unknown())
      .refine((params) => canonicalEncodedByteLength(params) <= MAX_INTEGRATION_PARAMS_BYTES, { message: "Parameters are too large" }),
  }).strict()),
  capability("memory.propose", z.object({
    kind: BotMemoryKindSchema,
    scope: BotMemoryScopeSchema,
    content: BotMemoryContentSchema,
    source: BotMemorySourceSchema,
  }).strict()),
  capability("memory.search", z.object({
    query: canonicalBoundedText(500, 2_000),
    limit: z.number().int().min(1).max(20),
  }).strict()),
  capability("interaction.create", z.object({
    blocking: z.boolean(),
    payload: BotInteractionPayloadSchema,
  }).strict()),
  capability("artifact.write", z.object({
    relPath: ArtifactPathSchema,
    content: z.string().max(BOT_ARTIFACT_MAX_BYTES)
      .refine((content) => textEncoder.encode(content).byteLength <= BOT_ARTIFACT_MAX_BYTES, { message: "Artifact is too large" }),
    mimeType: ArtifactMimeTypeSchema,
    replace: z.object({ baseRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  }).strict()),
  capability("artifact.read", z.object({ relPath: ArtifactPathSchema }).strict()),
]);

/** Serialized size includes JSON escaping, so it cannot exceed the broker's 256 KiB request cap. */
export const BotToolRequestSchema = BotToolRequestUnionSchema.refine(
  (request) => canonicalEncodedByteLength(request) <= MAX_TOOL_REQUEST_BYTES,
  { message: "Tool request is too large" },
);

export const BotToolErrorCodeSchema = z.enum([
  "denied",
  "not_granted",
  "approval_required",
  "invalid_arguments",
  "unavailable",
  "timeout",
  "budget_exhausted",
  "stale_generation",
]);

export const BotToolResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    content: z.array(z.object({ type: z.literal("text"), text: z.string().max(64 * 1024) }).strict()).min(1).max(16),
  }).strict(),
  z.object({ ok: z.literal(false), code: BotToolErrorCodeSchema }).strict(),
]);

/** Pi agent events projected for canonical Chat; model reasoning deltas are never forwarded. */
export const BotEventSchema = z.object({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("assistant_delta"), text: z.string().min(1).max(16 * 1024) }).strict(),
    z.object({
      type: z.literal("tool_progress"),
      toolCallId: ToolCallIdSchema,
      capability: BotToolCapabilitySchema,
      phase: z.enum(["started", "completed", "failed"]),
    }).strict(),
    z.object({ type: z.literal("activity"), label: canonicalBoundedText(200, 800), state: z.enum(["started", "completed", "failed"]) }).strict(),
  ]),
}).strict().refine((event) => canonicalEncodedByteLength(event) <= 64 * 1024, { message: "Event is too large" });

/** Pi transcript entries stay opaque here; the bot runtime owns their structure. */
export const BotSessionSaveRequestSchema = z.object({
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messages: z.array(z.record(z.string(), z.unknown())).max(4_000),
  compactedThroughSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine((request) => canonicalEncodedByteLength(request.messages) <= MAX_SESSION_BYTES, { message: "Session is too large" });

export type BotToolRequest = z.infer<typeof BotToolRequestSchema>;
export type BotToolCapability = z.infer<typeof BotToolCapabilitySchema>;
export type BotToolErrorCode = z.infer<typeof BotToolErrorCodeSchema>;
export type BotToolResult = z.infer<typeof BotToolResultSchema>;
export type BotEvent = z.infer<typeof BotEventSchema>;
export type BotSessionSaveRequest = z.infer<typeof BotSessionSaveRequestSchema>;

const BrokerEnvelope = {
  version: z.literal(1),
  requestId: z.string().uuid(),
  runtimeHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/),
  executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  runId: z.string().regex(/^run_[A-Za-z0-9_-]{1,128}$/),
};
const MAX_BROKER_REQUEST_BYTES = 256 * 1024;

/**
 * Bot frames on the scope-runtime broker socket: one newline-delimited JSON
 * request per connection. The runtime handle and generation authenticate the
 * workload; the gateway binds everything else at admission.
 */
export const BotBrokerRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...BrokerEnvelope, action: z.literal("bot.session.load") }).strict(),
  z.object({ ...BrokerEnvelope, action: z.literal("bot.session.save"), session: BotSessionSaveRequestSchema }).strict(),
  z.object({ ...BrokerEnvelope, action: z.literal("bot.tool"), tool: BotToolRequestSchema }).strict(),
  z.object({ ...BrokerEnvelope, action: z.literal("bot.event"), event: BotEventSchema }).strict(),
]).refine((request) => canonicalEncodedByteLength(request) <= MAX_BROKER_REQUEST_BYTES, { message: "Broker request is too large" });

export const BotSessionSnapshotSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messages: z.array(z.record(z.string(), z.unknown())).max(4_000),
}).strict();

export const BotSessionSaveResultSchema = z.object({ revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
export const BotEventAcceptedSchema = z.object({ accepted: z.literal(true) }).strict();

export const BotBrokerResponseSchema = z.discriminatedUnion("ok", [
  z.object({ version: z.literal(1), requestId: z.string().uuid(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ version: z.literal(1), requestId: z.string().uuid(), ok: z.literal(false), code: BotToolErrorCodeSchema }).strict(),
]);

export type BotBrokerRequest = z.infer<typeof BotBrokerRequestSchema>;
export type BotBrokerResponse = z.infer<typeof BotBrokerResponseSchema>;
export type BotSessionSnapshot = z.infer<typeof BotSessionSnapshotSchema>;
