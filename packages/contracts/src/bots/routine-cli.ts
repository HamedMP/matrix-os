import { z } from "zod/v4";
import { CanonicalChatIdSchema } from "#canonical-chat";
import { BotIdSchema } from "#bots/ids";
import { BotRoutineProposalSchema, BotRoutineScheduleSchema } from "#bots/routines";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const routineId = z.string().regex(/^rt_[a-f0-9]{24}$/);
const requestId = z.uuid();
export const RoutineCliActionSchema = z.enum(["read", "propose", "control"]);
export type RoutineCliAction = z.infer<typeof RoutineCliActionSchema>;
export const RoutineCliErrorCodeSchema = z.enum([
  "source_context_required", "permission_denied", "target_required", "target_unavailable",
  "revision_conflict", "request_conflict", "not_found", "unavailable", "invalid_input",
]);
export type RoutineCliErrorCode = z.infer<typeof RoutineCliErrorCodeSchema>;

/** Intent only. Source, target, owner and permissions are server-owned. */
const controlOperation = <T extends "pause" | "resume" | "archive">(operation: T) => z.object({
  operation: z.literal(operation), routineId, baseRevision: revision.min(1), requestId,
}).strict();
export const RoutineCliOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("show"), routineId }).strict(),
  z.object({ operation: z.literal("request"), requestId }).strict(),
  z.object({ operation: z.literal("propose"), requestId, proposal: BotRoutineProposalSchema }).strict(),
  controlOperation("pause"), controlOperation("resume"), controlOperation("archive"),
]);
export type RoutineCliOperation = z.infer<typeof RoutineCliOperationSchema>;

/** Owner UI only: these destination selectors never supply action authority. */
export const RoutineCliRememberTargetSchema = z.object({ botId: BotIdSchema, chatId: CanonicalChatIdSchema, baseRevision: revision }).strict();
export const RoutineCliResetTargetSchema = z.object({ baseRevision: revision }).strict();
export const RoutineCliTargetPreferenceSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  target: z.object({ botId: BotIdSchema, chatId: CanonicalChatIdSchema, bindingCreatedAt: z.iso.datetime({ offset: true }) }).strict().nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type RoutineCliTargetPreference = z.infer<typeof RoutineCliTargetPreferenceSchema>;

/** Public observed state only; never internal task/fire/approval/authorization records. */
export const RoutineCliObservedFireSchema = z.object({
  status: z.enum(["claimed", "dispatched", "completed", "failed", "cancelled", "uncertain"]),
  scheduledFor: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export const RoutineCliRoutineViewSchema = z.object({
  routineId, name: z.string().min(1).max(120), schedule: BotRoutineScheduleSchema,
  status: z.enum(["active", "paused", "archived"]), nextFireAt: z.iso.datetime({ offset: true }).nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lastFire: RoutineCliObservedFireSchema.nullable(), requiresReview: z.boolean(),
}).strict();
const ReceiptBase = z.object({ requestId, operation: z.enum(["propose", "pause", "resume", "archive"]),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), createdAt: z.iso.datetime({ offset: true }) });
const AppliedRoutine = z.object({ routineId, status: z.enum(["active", "paused", "archived"]), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const RoutineCliReceiptSchema = z.discriminatedUnion("disposition", [
  ReceiptBase.extend({ disposition: z.literal("queued") }).strict(),
  ReceiptBase.extend({ disposition: z.literal("pending_approval") }).strict(),
  ReceiptBase.extend({ disposition: z.literal("applied"), routine: AppliedRoutine }).strict(),
  ReceiptBase.extend({ disposition: z.literal("unknown"), reconcile: z.literal(true) }).strict(),
]);
export const RoutineCliResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), routines: z.array(RoutineCliRoutineViewSchema).max(32), truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal("show"), routine: RoutineCliRoutineViewSchema,
    history: z.object({ fires: z.array(RoutineCliObservedFireSchema).max(20), truncated: z.boolean() }).strict() }).strict(),
  z.object({ kind: z.literal("receipt"), receipt: RoutineCliReceiptSchema, current: RoutineCliRoutineViewSchema.nullable(),
    approval: z.enum(["pending", "resolved", "expired", "cancelled"]).nullable(),
    execution: z.object({ stop: z.literal("unconfirmed") }).strict().optional(),
    proposal: z.union([z.object({ handoff: z.enum(["reserved", "submitting", "canonical_queued", "canonical_accepted", "target_task_claimed", "pending_approval", "rejected", "unknown"]),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), approval: z.enum(["pending", "approved", "denied", "expired", "cancelled"]).nullable(),
      routine: AppliedRoutine.nullable(), routineLink: z.literal("unavailable").optional() }).strict()
      .refine(value => !value.routineLink || value.approval === "approved" && value.routine === null),
      z.object({ handoff: z.literal("pending_approval"), existingBinding: z.literal(true),
      approval: z.enum(["pending", "approved", "denied", "expired", "cancelled"]).nullable(), routine: AppliedRoutine.nullable(),
      routineLink: z.literal("unavailable").optional() }).strict()
      .refine(value => !value.routineLink || value.approval === "approved" && value.routine === null)]).optional() }).strict(),
  z.object({ kind: z.literal("not_observed"), requestId, mayStillArrive: z.literal(true) }).strict(),
  z.object({ kind: z.literal("unknown"), requestId, disposition: z.literal("unknown"), reconcile: z.literal(true) }).strict(),
]);
export type RoutineCliRoutineView = z.infer<typeof RoutineCliRoutineViewSchema>;
export type RoutineCliReceipt = z.infer<typeof RoutineCliReceiptSchema>;
export type RoutineCliResult = z.infer<typeof RoutineCliResultSchema>;
