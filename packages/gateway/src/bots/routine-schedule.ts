import cron from "node-cron";
import { BotRoutineScheduleSchema, type BotRoutineSchedule } from "@matrix-os/contracts";
/** One catch-up uses the stored occurrence; its successor starts after this pass, never a backlog burst. */
export function nextBotRoutineFire(raw: BotRoutineSchedule, now: string): string | null {
  const schedule = BotRoutineScheduleSchema.parse(raw),
    at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error("Invalid routine clock");
  if (schedule.kind === "once") return Date.parse(schedule.at) > at ? new Date(schedule.at).toISOString() : null;
  if (schedule.kind === "interval") return new Date(at + schedule.everyMs).toISOString();
  if (!cron.validate(schedule.expr)) throw new Error("Invalid routine cron");
  // node-cron's public next-run API is based on wall time. Never silently calculate from a different clock.
  if (Math.abs(Date.now() - at) > 1000) throw new Error("Routine clock differs from scheduler clock");
  const task = cron.createTask(schedule.expr, () => undefined, {
    timezone: schedule.tz
  });
  try {
    task.start();
    const next = task.getNextRun();
    if (!next || next.getTime() <= at) throw new Error("No future routine occurrence");
    return next.toISOString();
  } finally {
    task.destroy();
  }
}
