import { z } from "zod/v4";
import { BotRoutineIdSchema, BotIdSchema, BotTaskIdSchema } from "#bots/ids";
import { CanonicalChatIdSchema } from "#canonical-chat";
import { BotInteractionSchema } from "#bots/interactions";
import { BotRoutineProposalSchema } from "#bots/routines";

export const BotRoutineCursorSchema = z.object({ before: z.iso.datetime({ offset: true }), beforeId: BotRoutineIdSchema }).strict();
export const BotRoutineCenterQuerySchema = z.object({
  before: BotRoutineCursorSchema.shape.before.optional(), beforeId: BotRoutineIdSchema.optional(),
  archived: z.enum(["true", "false"]).optional(),
}).strict().refine(query => Boolean(query.before) === Boolean(query.beforeId));
export const BotRoutineFireViewSchema = z.object({
  fireId: z.string().regex(/^fire_[a-f0-9]{24}$/), taskId: BotTaskIdSchema, scheduledFor: z.iso.datetime({ offset: true }),
  status: z.enum(["claimed", "dispatched", "completed", "failed", "cancelled", "uncertain"]),
  attempts: z.number().int().min(0).max(100), failureCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export const BotRoutineCenterItemSchema = z.object({
  routineId: BotRoutineIdSchema, botId: BotIdSchema, chatId: CanonicalChatIdSchema,
  proposal: BotRoutineProposalSchema, computerId: z.string().min(1).max(128).nullable(),
  status: z.enum(["active", "paused", "archived"]), revision: z.number().int().positive(),
  nextFireAt: z.iso.datetime({ offset: true }).nullable(), requiresReview: z.boolean(), targetAvailable: z.boolean(),
  sourceAvailable: z.boolean(), lastFire: BotRoutineFireViewSchema.nullable(),
}).strict();
export const BotRoutineCenterResponseSchema = z.object({
  items: z.array(BotRoutineCenterItemSchema).max(32), pending: z.array(BotInteractionSchema).max(32),
  nextCursor: BotRoutineCursorSchema.nullable(),
}).strict();
export const BotRoutineDetailResponseSchema = z.object({
  routine: BotRoutineCenterItemSchema, history: z.array(BotRoutineFireViewSchema).max(100),
}).strict();
export const BotRoutineEditRequestSchema = z.object({
  baseRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: BotRoutineProposalSchema.shape.name, prompt: BotRoutineProposalSchema.shape.prompt, schedule: BotRoutineProposalSchema.shape.schedule,
}).strict();
export const BotRoutineEditResponseSchema = z.object({ interaction: BotInteractionSchema }).strict();
export type BotRoutineCenterItem = z.infer<typeof BotRoutineCenterItemSchema>;
export type BotRoutineCenterQuery = z.infer<typeof BotRoutineCenterQuerySchema>;
export type BotRoutineCenterResponse = z.infer<typeof BotRoutineCenterResponseSchema>;
export type BotRoutineDetailResponse = z.infer<typeof BotRoutineDetailResponseSchema>;
export type BotRoutineEditRequest = z.infer<typeof BotRoutineEditRequestSchema>;
