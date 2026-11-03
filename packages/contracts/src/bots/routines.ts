import { z } from "zod/v4";
const text = (max: number) => z.string().trim().min(1).max(max);
const timezone = text(80).refine(value => {
  try {
    new Intl.DateTimeFormat("en", {
      timeZone: value
    });
    return true;
  } catch (error: unknown) {
    if (error instanceof RangeError) return false;
    throw error;
  }
});
/** Definitions carry no owner/grant fields. The server binds them at approval. */
export const BotRoutineScheduleSchema = z.discriminatedUnion("kind", [z.object({
  kind: z.literal("once"),
  at: z.iso.datetime({
    offset: true
  })
}).strict(), z.object({
  kind: z.literal("interval"),
  everyMs: z.number().int().min(60_000).max(31 * 86_400_000)
}).strict(), z.object({
  kind: z.literal("cron"),
  expr: text(128).refine(expr => expr.trim().split(/\s+/).length === 5 && /^[0-9*,/\- ]+$/.test(expr)),
  tz: timezone
}).strict()]);
export const BotRoutineProposalSchema = z.object({
  name: text(120),
  prompt: text(4096),
  schedule: BotRoutineScheduleSchema,
  // This source already has explicit background authorization. No funded/key fallback.
  selection: z.object({
    instanceId: z.literal("matrix_chatgpt_plan"),
    model: text(128)
  }).strict(),
  authorizedEffects: z.array(z.enum(["read", "write", "send"])).min(1).max(3).refine(effects => new Set(effects).size === effects.length)
}).strict();
export type BotRoutineProposal = z.infer<typeof BotRoutineProposalSchema>;
export type BotRoutineSchedule = z.infer<typeof BotRoutineScheduleSchema>;
export type BotRoutineStatus = "active" | "paused" | "archived";
export type BotRoutineFireStatus = "claimed" | "dispatched" | "completed" | "failed" | "cancelled" | "uncertain";
export const BotRoutineControlSchema = z.object({
  baseRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["active", "paused", "archived"])
}).strict();
export const BotRoutineToolControlSchema = z.discriminatedUnion("operation", [z.object({
  operation: z.literal("list")
}).strict(), z.object({
  operation: z.literal("control"),
  routineId: z.string().regex(/^rt_[a-f0-9]{24}$/),
  ...BotRoutineControlSchema.shape
}).strict()]);
