import {
  AiUsageBackupSchema,
  readUsageExport,
} from "@matrix-os/contracts/ai-usage";
import { AppError } from "../../../shared/app-error";
import type { ApiClient } from "./api";
const readOptions = (signal: AbortSignal) => ({
  signal,
  timeoutMs: 65000,
  maxBytes: 16 * 1024 * 1024,
  cache: "no-store" as const,
});
/** Older runtimes expose owner files before they have the historical-index route. */
export async function loadMatrixUsage(
  api: Pick<ApiClient, "get">,
  owner: string | null,
  signal: AbortSignal,
) {
  if (!owner) throw new Error("Usage unavailable");
  signal.throwIfAborted();
  let recent: ReturnType<typeof readUsageExport> | undefined;
  try {
    const value = await api.get("/api/ai-usage", readOptions(signal));
    signal.throwIfAborted();
    const snapshot = readUsageExport(value);
    if (snapshot.history) return { snapshot, backup: false };
    recent = snapshot;
  } catch (error: unknown) {
    signal.throwIfAborted();
    if (!(error instanceof AppError && error.httpStatus === 404)) throw error;
  }
  let value;
  try { value = await api.get(
    `/api/files/blob?path=${encodeURIComponent("exports/ai-usage/latest.json")}`,
    readOptions(signal),
  ); } catch(error:unknown) {
    signal.throwIfAborted();
    if (recent && error instanceof AppError && error.httpStatus === 404) return {snapshot:recent,backup:false};
    throw error;
  }
  signal.throwIfAborted();
  const backup = AiUsageBackupSchema.parse(value);
  if (backup.ownerId !== owner || !backup.report.history)
    throw new Error("Usage unavailable");
  return { snapshot: backup.report, backup: true };
}
