import { z } from "zod/v4";

/**
 * Why a Matrix computer must stay awake. `unknown` means a busy-state source
 * failed or timed out; callers must treat it as busy and never suspend on it.
 */
export const RuntimeBusyReasonSchema = z.enum([
  "chat_run",
  "terminal_attached",
  "background_agent",
  "routine",
  "unknown",
]);
export type RuntimeBusyReason = z.infer<typeof RuntimeBusyReasonSchema>;

/** `GET /api/system/lifecycle` response, read by the platform idle sleeper. */
export const RuntimeLifecycleStatusSchema = z.object({
  busy: z.boolean(),
  busyReasons: z.array(RuntimeBusyReasonSchema).max(RuntimeBusyReasonSchema.options.length),
  /** Earliest future cron or routine time (ISO 8601) among the sources that answered, or null. */
  nextScheduledAt: z.iso.datetime().nullable(),
  /** False when any schedule source failed or timed out; callers must not suspend on an incomplete schedule. */
  scheduleComplete: z.boolean(),
}).strict().refine((status) => status.busy === status.busyReasons.length > 0, {
  message: "busy must match busyReasons",
});
export type RuntimeLifecycleStatus = z.infer<typeof RuntimeLifecycleStatusSchema>;
