import { z } from "zod/v4";
import { CanonicalChatRunPolicySchema, CanonicalChatArgumentDigestSchema, CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalOwnerScopeSchema } from "#canonical-chat";

const ref = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
/**
 * Slash-separated workspace path (e.g. `apps/timer/src/main.tsx`). Every
 * segment stays a safe ref — `..`, empty, hidden and `/`-prefixed segments are
 * rejected — so projected paths are never traversal or absolute escapes.
 */
const pathRef = (max: number) => z.string().min(1).max(max).refine(
  (value) => value.split("/").every((segment) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(segment)),
  { message: "Invalid operation result path" },
);
export const CanonicalExecutionPolicySchema = CanonicalChatRunPolicySchema.shape.executionPolicy.unwrap();
export type CanonicalExecutionPolicy = z.infer<typeof CanonicalExecutionPolicySchema>;
// JSON only, bounded before recursive traversal; reject cycles, getters and exotic objects.
export const BoundedActionJsonSchema = z.unknown().superRefine((value, ctx) => {
  let nodes = 0;
  function valid(v: unknown, depth: number): boolean {
    if (++nodes > 16_384 || depth > 32) return false;
    if (v === null || typeof v === "boolean" || typeof v === "string") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "object") return false;
    if (Object.getOwnPropertySymbols(v).length) return false;
    if (Array.isArray(v)) return v.length <= 16_384 && Object.keys(v).length === v.length && Array.from({ length: v.length }, (_, i) => Object.getOwnPropertyDescriptor(v, String(i))).every((d) => d && "value" in d && valid(d.value, depth + 1));
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
    return Object.values(Object.getOwnPropertyDescriptors(v)).every((d) => d.enumerable && "value" in d && valid(d.value, depth + 1));
  }
  if (!valid(value, 0) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536) ctx.addIssue({ code: "custom", message: "Invalid or oversized action JSON" });
});
export const CanonicalActionIdSchema = z.string().max(128).regex(/^action_[A-Za-z0-9_-]+$/);
export const CanonicalOperationSchema = z.object({
  id: CanonicalActionIdSchema,
  owner: CanonicalOwnerScopeSchema,
  chatId: CanonicalChatIdSchema,
  runId: CanonicalChatRunIdSchema,
  workspaceScope: z.string().min(1).max(160),
  policyRevision: ref(160),
  executionPolicy: CanonicalExecutionPolicySchema,
  toolId: ref(80),
  schemaRevision: ref(160),
  arguments: BoundedActionJsonSchema,
  argumentDigest: CanonicalChatArgumentDigestSchema,
  state: z.enum(["proposed", "waiting_for_approval", "authorized", "running", "succeeded", "failed", "cancelled", "timed_out", "outcome_unknown"]),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  claimToken: ref(128).optional(),
  result: BoundedActionJsonSchema.optional(),
  cancellationRequested: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((op, ctx) => {
  if (op.policyRevision !== op.executionPolicy.revision || op.workspaceScope !== op.executionPolicy.workspaceScope) ctx.addIssue({ code: "custom", message: "Operation policy identity mismatch" });
});
export type CanonicalOperation = z.infer<typeof CanonicalOperationSchema>;

/**
 * The pinned server-owned fallback a live voice session may stamp onto its
 * runs. `conversation_only` with an empty tool inventory and no delegation is
 * self-enforcing — the canonical authority rejects every tool invocation under
 * it and no provider grant is transported — so admission may accept this exact
 * policy without an adapter `qualifyPolicy` echo. Any other frozen policy
 * still requires byte-exact adapter attestation. The revision is pinned so a
 * session can never widen the exemption by inventing a variant.
 */
export const CANONICAL_VOICE_CONVERSATION_ONLY_POLICY = Object.freeze(
  CanonicalExecutionPolicySchema.parse({
    revision: "voice_conversation_only_v1",
    actionMode: "conversation_only",
    workspaceScope: "apps",
    tools: [],
    delegation: false,
  }),
);

/**
 * Safe client projection of a canonical operation. Raw `arguments`, raw
 * `result` payloads and `claimToken` never leave the server; only whitelisted,
 * schema-validated result fields per tool are projected. Unknown tools project
 * no result detail at all.
 */
export const CanonicalOperationResultViewSchema = z.object({
  navigation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open_app"), app: ref(80), path: pathRef(160) }).strict(),
    z.object({ kind: z.literal("close_app"), app: ref(80), path: pathRef(160) }).strict(),
  ]).optional(),
  artifact: z.object({ kind: ref(40), path: pathRef(160) }).strict().optional(),
  apps: z.array(z.object({ app: ref(80), name: z.string().min(1).max(160) }).strict()).max(32).optional(),
  files: z.array(z.object({
    path: pathRef(160),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    truncated: z.boolean().optional(),
  }).strict()).max(32).optional(),
  matches: z.array(z.object({
    path: pathRef(160),
    line: z.number().int().min(1).max(1_000_000),
    text: z.string().max(240),
  }).strict()).max(32).optional(),
}).strict();
export type CanonicalOperationResultView = z.infer<typeof CanonicalOperationResultViewSchema>;

export const CanonicalOperationViewSchema = z.object({
  id: CanonicalActionIdSchema,
  chatId: CanonicalChatIdSchema,
  runId: CanonicalChatRunIdSchema,
  toolId: ref(80),
  schemaRevision: ref(160),
  policyRevision: ref(160),
  state: z.enum(["proposed", "waiting_for_approval", "authorized", "running", "succeeded", "failed", "cancelled", "timed_out", "outcome_unknown"]),
  argumentDigest: CanonicalChatArgumentDigestSchema,
  cancellationRequested: z.boolean(),
  result: CanonicalOperationResultViewSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type CanonicalOperationView = z.infer<typeof CanonicalOperationViewSchema>;
