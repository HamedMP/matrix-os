import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

export const CLIENT_ERROR_LOG_BODY_LIMIT = 16 * 1024;

export const ClientErrorReportSchema = z.object({
  errorId: z.string().regex(/^mx-[A-Za-z0-9._:-]{1,128}$/).max(160),
  source: z.string().max(80).optional(),
  name: z.string().max(120).optional(),
  message: z.string().max(1_000).optional(),
  stack: z.string().max(4_000).optional(),
  digest: z.string().max(160).optional(),
  path: z.string().max(512).optional(),
  userAgent: z.string().max(512).optional(),
  buildSha: z.string().max(128).optional(),
}).strict();

export type ClientErrorReport = z.infer<typeof ClientErrorReportSchema>;

export interface ClientErrorLogEntry extends ClientErrorReport {
  timestamp: string;
}

export function clientErrorLogPath(homePath: string): string {
  return join(homePath, "system", "logs", "client-errors.jsonl");
}

export interface ClientErrorExceptionTracker {
  captureException(
    error: unknown,
    options?: {
      distinctId?: string;
      properties?: Record<string, string | number | boolean | null | undefined>;
    },
  ): Promise<boolean>;
}

function logForwardFailure(err: unknown): void {
  // Error NAME only: capture failures must never echo provider details,
  // messages, or paths into gateway logs.
  const kind = err instanceof Error ? err.name : typeof err;
  console.warn(`[client-error-log] PostHog forward failed: ${kind}`);
}

/**
 * Forward a validated shell client error report to PostHog error tracking as
 * a reconstructed exception. Fire-and-forget: failures are logged by error
 * name only and never affect the HTTP response or the local JSONL append.
 * The reconstructed message/stack are the error-tracking payload itself;
 * event properties stay free of raw messages and paths.
 */
export function forwardClientErrorToPostHog(
  tracker: ClientErrorExceptionTracker,
  distinctId: string,
  report: ClientErrorReport,
): void {
  try {
    const error = new Error(report.message ?? "Client error report without message");
    error.name = report.name ?? "ClientError";
    if (report.stack) {
      error.stack = report.stack;
    }
    void tracker
      .captureException(error, {
        distinctId,
        properties: {
          source: "shell-client-error",
          report_source: report.source,
          digest: report.digest,
          errorId: report.errorId,
          path: report.path,
          build_sha: report.buildSha,
          user_agent: report.userAgent,
        },
      })
      .catch(logForwardFailure);
  } catch (err: unknown) {
    logForwardFailure(err);
  }
}

export async function writeClientErrorReport(
  homePath: string,
  report: ClientErrorReport,
): Promise<ClientErrorLogEntry> {
  const entry: ClientErrorLogEntry = {
    ...report,
    timestamp: new Date().toISOString(),
  };
  const path = clientErrorLogPath(homePath);
  await mkdir(join(homePath, "system", "logs"), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
  return entry;
}
