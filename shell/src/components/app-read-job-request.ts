import { AppIntegrationAppSchema, AppReadJobInputSchema, AppReadJobPauseInputSchema, AppReadJobConfigureInputSchema } from "@matrix-os/contracts";

export const APP_READ_JOB_PATHS = ["/api/app-read-jobs/status", "/api/app-read-jobs/run", "/api/app-read-jobs/pause", "/api/app-read-jobs/configure"];
export function prepareAppReadJobRequest(app: string, url: string, init: RequestInit): RequestInit {
  const identity = AppIntegrationAppSchema.parse(app);
  if (!APP_READ_JOB_PATHS.includes(url) || init.method !== "POST" || typeof init.body !== "string" || init.body.length > 4096) throw new Error("Invalid app read job request");
  const input = (url.endsWith("/configure") ? AppReadJobConfigureInputSchema : url.endsWith("/pause") ? AppReadJobPauseInputSchema : AppReadJobInputSchema).parse(JSON.parse(init.body));
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: identity, ...input }) };
}
