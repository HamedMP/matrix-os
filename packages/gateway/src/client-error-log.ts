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
