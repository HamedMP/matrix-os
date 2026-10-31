import { z } from "zod/v4";
import { CanonicalChatIdSchema } from "#canonical-chat";
import { BotIdSchema } from "#bots/ids";
import { BotRoutineProposalSchema } from "#bots/routines";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const routineId = z.string().regex(/^rt_[a-f0-9]{24}$/);
const requestId = z.uuid();
export const RoutineCliActionSchema = z.enum(["read", "propose", "control"]);
export type RoutineCliAction = z.infer<typeof RoutineCliActionSchema>;
export const RoutineCliErrorCodeSchema = z.enum([
  "source_context_required", "permission_denied", "target_required", "target_unavailable",
  "revision_conflict", "unavailable", "invalid_input",
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
