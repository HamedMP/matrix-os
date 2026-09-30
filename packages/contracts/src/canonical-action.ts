import { z } from "zod/v4";
import { CanonicalChatRunPolicySchema, CanonicalChatArgumentDigestSchema, CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalOwnerScopeSchema } from "#canonical-chat";

const ref = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
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
