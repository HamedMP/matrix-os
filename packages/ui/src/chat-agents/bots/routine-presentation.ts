import { BotRoutineProposalSchema, type BotRoutineSchedule, type BotRoutineCenterItem } from "@matrix-os/contracts";
import { z } from "zod/v4";

const source = z.object({ computerId: z.string().min(1).max(128), accountId: z.string().min(1).max(128),
  grantRevision: z.number().int().positive(), definitionRevision: z.number().int().positive(),
  routineId: z.string().regex(/^rt_[a-f0-9]{24}$/).optional(), baseRoutineRevision: z.number().int().positive().optional(),
}).strict().refine(value => Boolean(value.routineId) === Boolean(value.baseRoutineRevision));
const envelope = z.object({ proposal: BotRoutineProposalSchema, source, estimatedNextFireAt: z.iso.datetime({ offset: true }).nullable().optional() }).strict();
export const ROUTINE_EXECUTION_IMPACT = "Runs without a new message using your connected ChatGPT subscription while the connected desktop stays online. Approving allows only this task. Other actions still need their own permission.";

/** Shared display policy only; persisted service state remains authoritative. */
export function routineNextRun(row: BotRoutineCenterItem): string {
  if (row.status === "archived") return "No future runs · archived";
  if (row.status === "paused") return "No future runs · paused";
  if (row.requiresReview || !row.targetAvailable || !row.sourceAvailable) return "Review required before execution";
  if (!row.nextFireAt) return "None scheduled";
  // The device zone can change while a retained Chat remains mounted.
  const formatter = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
  return `${formatter.format(new Date(row.nextFireAt))} (${formatter.resolvedOptions().timeZone})`;
}

export function routineStatusLabel(row: BotRoutineCenterItem): string {
  if (row.status === "archived") return "Archived";
  if (!row.targetAvailable) return "Target unavailable";
  if (row.requiresReview || !row.sourceAvailable) return "Needs review";
  if (row.lastFire?.status === "uncertain") return "Execution uncertain";
  if (row.lastFire && ["claimed", "dispatched"].includes(row.lastFire.status)) return "Running";
  if (row.status === "paused") return row.lastFire?.status === "failed" ? "Paused after failure" : "Paused";
  return row.lastFire?.status === "failed" ? "Active · last run failed" : "Active";
}

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
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const join = (values: string[]) => values.length < 3 ? values.join(" and ") : `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
  let frequency = `Custom repeat rule: ${schedule.expr}`;
  if (clock && day === "*" && month === "*") {
    if (weekday === "*") frequency = `Every day at ${clock}`;
    else if (weekday === "1-5") frequency = `Weekdays at ${clock}`;
    else if (/^[0-7](?:,[0-7])*$/.test(weekday!)) {
      const selected = [...new Set(weekday!.split(",").map(value => Number(value) % 7))];
      frequency = `Every ${join(selected.map(value => days[value]!))} at ${clock}`;
    }
  } else if (clock && /^\d+$/.test(day!) && month === "*" && weekday === "*") frequency = `Monthly on day ${day} at ${clock}`;
  else if (hour === "*" && day === "*" && month === "*" && weekday === "*") {
    if (minute === "*") frequency = "Every minute";
    else if (/^\d+$/.test(minute!)) frequency = `Every hour at minute ${minute}`;
    else if (/^\*\/[1-9]\d?$/.test(minute!) && 60 % Number(minute!.slice(2)) === 0) frequency = `Every ${Number(minute!.slice(2))} minutes`;
  }
  return { frequency, timezone: schedule.tz, next: "Next matching time after approval" };
}
