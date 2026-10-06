import { z } from "zod/v4";
import { AppIntegrationAppSchema } from "./app-integrations.js";

export const APP_READ_JOB_CHANNEL = "native-app:read-job";
export const AppReadJobIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
export const AppReadJobInputSchema = z.strictObject({ jobId: AppReadJobIdSchema });
export const AppReadJobPauseInputSchema = AppReadJobInputSchema.extend({ paused: z.boolean() });
export const AppReadJobRequestSchema = AppReadJobInputSchema.extend({ app: AppIntegrationAppSchema });
export const AppReadJobPauseRequestSchema = AppReadJobPauseInputSchema.extend({ app: AppIntegrationAppSchema });
export const AppReadJobSummarySettingsSchema = z.strictObject({
  enabled: z.boolean(), timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
    catch (error) { if (error instanceof RangeError) return false; throw error; }
  }).optional(), minimumIntervalMs: z.number().int().min(1800000).max(86400000).optional(), dailyHour: z.number().int().min(0).max(23).optional(),
});
const SourceBaseSchema = z.object({
  id: AppReadJobIdSchema, connectionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), label: z.string().trim().min(1).max(100),
});
const ScopeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const AppReadJobSourceSchema = z.discriminatedUnion("service", [
  SourceBaseSchema.extend({ service: z.literal("github"), params: z.strictObject({ repo: z.string().max(256).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => value.split("/").every(part => part !== "." && part !== "..")) }) }).strict(),
  SourceBaseSchema.extend({ service: z.literal("linear"), params: z.strictObject({ teamId: ScopeIdSchema.optional(), projectId: ScopeIdSchema.optional() }).refine(value => Boolean(value.teamId || value.projectId)) }).strict(),
  SourceBaseSchema.extend({ service: z.literal("slack"), params: z.strictObject({ channel: z.string().regex(/^[CG][A-Z0-9]{1,64}$/) }) }).strict(),
  SourceBaseSchema.extend({ service: z.literal("posthog"), params: z.strictObject({ region: z.enum(["eu", "us"]), projectId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }) }).strict(),
]);
const SourcesSchema = z.array(AppReadJobSourceSchema).min(1).max(8).refine(value => new Set(value.map(source => source.id)).size === value.length);
export type AppReadJobSource = z.infer<typeof AppReadJobSourceSchema>;
export const AppReadJobSettingsSchema = z.strictObject({
  sources: SourcesSchema.optional(), enabled: z.boolean().optional(), intervalMs: z.number().int().min(900000).max(86400000).optional(), summary: AppReadJobSummarySettingsSchema.optional(),
}).refine(value => Object.keys(value).length > 0);
export const AppReadJobConfigureInputSchema = AppReadJobInputSchema.extend({ settings: AppReadJobSettingsSchema });
export const AppReadJobConfigureRequestSchema = AppReadJobConfigureInputSchema.extend({ app: AppIntegrationAppSchema });
export type AppReadJobSettings = z.infer<typeof AppReadJobSettingsSchema>;
export const AppReadJobInvokeSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status"), input: AppReadJobInputSchema }),
  z.strictObject({ action: z.literal("run"), input: AppReadJobInputSchema }),
  z.strictObject({ action: z.literal("pause"), input: AppReadJobPauseInputSchema }),
  z.strictObject({ action: z.literal("configure"), input: AppReadJobConfigureInputSchema }),
]);
const TimestampSchema = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString());
export const AppReadJobStateSchema = z.strictObject({
  generation: z.number().int().nonnegative(), paused: z.boolean(),
  status: z.enum(["idle", "paused", "running", "completed", "partial", "failed", "aborted"]),
  nextDueAt: TimestampSchema,
  lastAttemptAt: TimestampSchema.nullable(), lastSuccessAt: TimestampSchema.nullable(), leaseUntil: TimestampSchema.nullable(),
  configuration: z.strictObject({ sources: SourcesSchema.optional(), enabled: z.boolean(), intervalMs: z.number().int().min(900000).max(86400000), summary: AppReadJobSummarySettingsSchema.nullable().optional() }).optional(),
  summaryAt: TimestampSchema.nullable(), summaryAttemptAt: TimestampSchema.nullable().optional(), summaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export const AppReadJobStatusResponseSchema = z.strictObject({ jobId: AppReadJobIdSchema, state: AppReadJobStateSchema.nullable() });
export const AppReadJobRunResponseSchema = z.strictObject({ status: z.enum(["accepted", "busy", "disabled"]) });
export type AppReadJobInvoke = z.infer<typeof AppReadJobInvokeSchema>;

export function createAppReadJobClient(invoke: (request: AppReadJobInvoke) => Promise<unknown>) {
  async function call<T>(request: AppReadJobInvoke, schema: z.ZodType<T>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([invoke(AppReadJobInvokeSchema.parse(request)).then(value => schema.parse(value)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("App read job timed out")), 30_000);
      })]);
    } catch (error) {
      console.warn("[app-read-jobs] request failed:", error instanceof Error ? error.name : "UnknownError");
      throw new Error("App read job is unavailable");
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    readJobStatus: async (jobId: string) => call({ action: "status", input: { jobId } }, AppReadJobStatusResponseSchema),
    runReadJob: async (jobId: string) => call({ action: "run", input: { jobId } }, AppReadJobRunResponseSchema),
    configureReadJob: async (jobId: string, settings: AppReadJobSettings) => call({ action: "configure", input: { jobId, settings } }, AppReadJobStatusResponseSchema),
    pauseReadJob: async (jobId: string, paused: boolean) => call({ action: "pause", input: { jobId, paused } }, AppReadJobStatusResponseSchema),
  });
}
