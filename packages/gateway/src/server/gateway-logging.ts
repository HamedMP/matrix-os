/** The gateway's best-effort failure logs and its self-healing activity log, moved out of server.ts. */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export function logBestEffortFailure(context: string, err: unknown): void {
  console.warn(`[gateway] ${context}:`, err instanceof Error ? err.message : String(err));
}

export function logUnexpectedJsonParseFailure(context: string, err: unknown): void {
  if (!(err instanceof SyntaxError)) logBestEffortFailure(context, err);
}

export function logUnexpectedWsSendFailure(context: string, err: unknown): void {
  if (!(err instanceof Error && /not open|not opened|closed/i.test(err.message))) logBestEffortFailure(context, err);
}

/** Appends a [heal] line to the home's system/activity.log; a failed append is only warned about. */
export function createHealingLog(homePath: string): (message: string) => void {
  return (message) => {
    appendFile(join(homePath, "system/activity.log"), `[${new Date().toISOString()}] [heal] ${message}\n`)
      .catch((err: unknown) => {
        console.warn("[heal] failed to append activity log:", err instanceof Error ? err.message : String(err));
      });
  };
}
