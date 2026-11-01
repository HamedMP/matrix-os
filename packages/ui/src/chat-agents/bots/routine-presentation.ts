import { BotRoutineProposalSchema, type BotRoutineSchedule } from "@matrix-os/contracts";
import { z } from "zod/v4";

const source = z.object({ computerId: z.string().min(1).max(128), accountId: z.string().min(1).max(128),
  grantRevision: z.number().int().positive(), definitionRevision: z.number().int().positive(),
  routineId: z.string().regex(/^rt_[a-f0-9]{24}$/).optional(), baseRoutineRevision: z.number().int().positive().optional(),
}).strict().refine(value => Boolean(value.routineId) === Boolean(value.baseRoutineRevision));
const envelope = z.object({ proposal: BotRoutineProposalSchema, source, estimatedNextFireAt: z.iso.datetime({ offset: true }).nullable().optional() }).strict();

/** Display only. The service checks the stored digest/source; parsing never grants approval. */
export function routineApprovalPreview(preview: string) {
  if (preview.length > 32 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(preview); }
  catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const parsed = envelope.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function routineScheduleCopy(schedule: BotRoutineSchedule): { frequency: string; timezone: string; next: string } {
  if (schedule.kind === "interval") {
    const n = schedule.everyMs, units: [number, string][] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]];
    const [size, unit] = units.find(([size]) => n % size === 0) ?? [1000, "second"];
    const count = n / size, duration = `${count} ${unit}${count === 1 ? "" : "s"}`;
    return { frequency: `Every ${duration}`, timezone: "Elapsed time", next: `${duration} after approval` };
  }
  if (schedule.kind === "once") return { frequency: "Once", timezone: "UTC", next: new Intl.DateTimeFormat("en", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(schedule.at)) };
  const [minute, hour, day, month, weekday] = schedule.expr.trim().split(/\s+/);
  const clock = /^\d+$/.test(hour!) && /^\d+$/.test(minute!) ? `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}` : null;
  const frequency = clock && day === "*" && month === "*" && weekday === "*" ? `Every day at ${clock}`
    : clock && day === "*" && month === "*" && weekday === "1-5" ? `Weekdays at ${clock}` : "Custom recurring schedule";
  return { frequency, timezone: schedule.tz, next: "Next matching time after approval" };
}
