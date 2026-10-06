import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { AppReadJobSourceSchema } from "@matrix-os/contracts";
import type { AppIntegrationInput } from "@matrix-os/contracts";
import type { TableDef } from "../app-db-types.js";

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
export const ReadJobSourceSchema = AppReadJobSourceSchema;
export const SummarySettingsSchema = z.strictObject({
  enabled: z.boolean(), timezone: z.string().max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch (error) { if (error instanceof RangeError) return false; throw error; }
  }).default("Asia/Shanghai"), minimumIntervalMs: z.number().int().min(1800000).max(86400000).default(1800000),
  dailyHour: z.number().int().min(0).max(23).default(9),
});
export const ReadJobSchema = z.strictObject({
  id: name, app: name, recipe: z.literal("developer-briefing-v1"), enabled: z.boolean(),
  intervalMs: z.number().int().min(900000).max(86400000), sources: z.array(ReadJobSourceSchema).min(1).max(8),
  summary: SummarySettingsSchema.optional(),
}).refine(job => new Set(job.sources.map(item => item.id)).size === job.sources.length);
export const ReadJobConfigSchema = z.strictObject({ jobs: z.array(ReadJobSchema).max(8) })
  .refine(config => new Set(config.jobs.map(job => `${job.app}/${job.id}`)).size === config.jobs.length);
export type ReadJob = z.infer<typeof ReadJobSchema>;
export type ReadSource = ReadJob["sources"][number];
export type SafeReadError = "denied" | "invalid" | "unavailable" | "busy" | "timeout" | "budget";
export interface ReadJobRecord { action: string; params: AppIntegrationInput["params"]; data: JsonValue }
export interface ReadJobSnapshot {
  sourceKey: string; service: ReadSource["service"]; scope: ReadSource["params"];
  coverage: "complete" | "partial" | "unavailable"; observedAt: string; lastSuccessAt: string | null;
  records: ReadJobRecord[]; error?: SafeReadError;
}
export interface ReadJobClaim { generation: number; startedAt: string }
export interface ReadJobSummary { status: "completed" | "unavailable" | "not_due" | "not_configured"; data?: JsonValue; generatedAt?: string; hash?: string }
export interface ReadJobCompletion { snapshots: ReadJobSnapshot[]; status: "completed" | "partial" | "failed" | "aborted"; summary?: ReadJobSummary }
export interface ReadJobStatus {
  generation: number; paused: boolean; status: string; nextDueAt: string; lastAttemptAt: string | null; lastSuccessAt: string | null;
  leaseUntil: string | null; summaryAt: string | null; summaryAttemptAt: string | null; summaryHash: string | null;
}
export const READ_JOB_TABLES: Record<string, TableDef> = {
  read_job_state: { columns: { key: "text", owner_id: "text", job_id: "text", config_hash: "text", generation: "integer", paused: "boolean", status: "text", next_due_at: "timestamptz", lease_until: "timestamptz", last_attempt_at: "timestamptz", last_success_at: "timestamptz", summary_at: "timestamptz", summary_attempt_at: "timestamptz", summary_hash: "text" }, uniqueIndexes: ["key"] },
  read_job_runs: { columns: { key: "text", owner_id: "text", job_id: "text", generation: "integer", status: "text", data: "jsonb", started_at: "timestamptz", finished_at: "timestamptz" }, uniqueIndexes: ["key"] },
  read_job_snapshots: { columns: { key: "text", owner_id: "text", job_id: "text", source_key: "text", data: "jsonb", observed_at: "timestamptz", success_at: "timestamptz" }, uniqueIndexes: ["key"] },
};
export const jobHash = (job: ReadJob) => createHash("sha256").update(JSON.stringify(job)).digest("hex");
export const rowKey = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export function contentHash(snapshots: ReadJobSnapshot[]) {
  return createHash("sha256").update(JSON.stringify(snapshots.map(({ sourceKey, service, scope, coverage, records, error }) => ({ sourceKey, service, scope, coverage, records, error })))).digest("hex");
}
export function summaryDue(settings: ReadJob["summary"], previous: { hash: string | null; at: string | null; attemptedAt?: string | null }, hash: string, now: Date): boolean {
  if (!settings?.enabled) return false;
  const attemptedAt=previous.attemptedAt??previous.at;
  if(attemptedAt&&now.getTime()-Date.parse(attemptedAt)<settings.minimumIntervalMs)return false;
  const local = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const parts = local(now);
  const day = (values: Intl.DateTimeFormatPart[]) => values.filter(part => ["year", "month", "day"].includes(part.type)).map(part => part.value).join("-");
  const daily = Number(parts.find(part => part.type === "hour")?.value) >= settings.dailyHour && (!previous.at || day(parts) !== day(local(new Date(previous.at))) || Number(local(new Date(previous.at)).find(part => part.type === "hour")?.value) < settings.dailyHour);
  return daily || (hash !== previous.hash && (!previous.at || now.getTime() - Date.parse(previous.at) >= settings.minimumIntervalMs));
}
