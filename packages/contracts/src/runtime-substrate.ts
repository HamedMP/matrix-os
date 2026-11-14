import { z } from "zod/v4";

export const SubstrateKindSchema = z.enum(["vps", "container"]);
export type SubstrateKind = z.infer<typeof SubstrateKindSchema>;

export const RuntimeStateSchema = z.enum([
  "ready", "waking", "restoring", "busy", "limit_reached", "failed", "migrating", "waitlisted",
]);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const RuntimeLimitReasonSchema = z.enum(["ai_allowance", "storage", "compute"]);
export type RuntimeLimitReason = z.infer<typeof RuntimeLimitReasonSchema>;

/**
 * The body a platform returns instead of proxying when the owner's runtime is not ready
 * (waking a stopped container, busy at capacity, or held at a limit). `limit` names the
 * limit exactly when the state is `limit_reached`; `resetsAt` says when it lifts on its
 * own, for limits that reset (the monthly compute limit). `error` is fixed copy, never
 * provider or database text.
 */
export const RuntimeStateResponseSchema = z.object({
  error: z.string().max(200).optional(),
  runtimeState: RuntimeStateSchema,
  limit: RuntimeLimitReasonSchema.optional(),
  resetsAt: z.iso.datetime().optional(),
}).strict().refine(
  (body) => (body.runtimeState === "limit_reached") === (body.limit !== undefined)
    && (body.resetsAt === undefined || body.limit !== undefined),
  { message: "limit is required exactly for limit_reached, and resetsAt only with a limit" },
);
export type RuntimeStateResponse = z.infer<typeof RuntimeStateResponseSchema>;

export const RuntimeProfileCapabilityIdSchema = z.enum([
  "chat.matrix_ai", "chat.coding_harness", "apps.build", "apps.node_runtime",
  "files", "terminal", "code_editor", "channels", "cron", "bots",
  "integrations", "sites.publish",
]);
export type RuntimeProfileCapabilityId = z.infer<typeof RuntimeProfileCapabilityIdSchema>;

export const RuntimeProfileCapabilityStateSchema = z.enum([
  "available", "disabled-by-policy", "unsupported", "setup-required", "temporarily-unavailable",
]);
export type RuntimeProfileCapabilityState = z.infer<typeof RuntimeProfileCapabilityStateSchema>;

export const RuntimeProfileCapabilitySchema = z.object({
  state: RuntimeProfileCapabilityStateSchema,
  upgradeUnlocks: z.boolean().optional(),
}).strict();

export const RuntimeCapabilitiesV1Schema = z.object({
  version: z.literal(1),
  substrate: SubstrateKindSchema,
  capabilities: z.record(RuntimeProfileCapabilityIdSchema, RuntimeProfileCapabilitySchema),
}).strict();
export type RuntimeCapabilitiesV1 = z.infer<typeof RuntimeCapabilitiesV1Schema>;
