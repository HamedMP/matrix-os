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
  /** Earliest future cron, routine or heartbeat time (ISO 8601), or null when none is known. */
  nextScheduledAt: z.iso.datetime().nullable(),
}).strict().refine((status) => status.busy === status.busyReasons.length > 0, {
  message: "busy must match busyReasons",
});
export type RuntimeLifecycleStatus = z.infer<typeof RuntimeLifecycleStatusSchema>;
