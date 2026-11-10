import {
  AiUsageBackupSchema,
  readUsageExport,
} from "@matrix-os/contracts/ai-usage";
export const USAGE_EXPORT_PATH = "exports/ai-usage/latest.json";
/** Shared by every surface so web and desktop resolve the same report for the same computer.
 * The live index wins. A computer without one (404) may serve the owner-bound export instead.
 * Authentication, service and validation failures never fall back to older data. */
export async function loadMatrixUsage(
  transport: {
    /** Resolves parsed JSON; rejects on any non-2xx response. */
    get(path: string, signal: AbortSignal): Promise<unknown>;
    /** HTTP status of a rejected `get`, when there was a response. */
    status(error: unknown): number | undefined;
  },
  owner: string | null | undefined,
  signal: AbortSignal,
  options: { syncedExport?: boolean; timeZone?: string } = {},
) {
  signal.throwIfAborted();
  let recent: ReturnType<typeof readUsageExport> | undefined;
  if (!options.syncedExport) {
    try {
      const query = options.timeZone
        ? `?timeZone=${encodeURIComponent(options.timeZone)}`
        : "";
      const value = await transport.get(`/api/ai-usage${query}`, signal);
      signal.throwIfAborted();
      const snapshot = readUsageExport(value);
      if (snapshot.history) return { snapshot, backup: false };
      recent = snapshot;
    } catch (error: unknown) {
      signal.throwIfAborted();
      if (transport.status(error) !== 404) throw error;
    }
  }
  // An export is only trusted when it can be matched to a known signed-in owner.
  if (!owner) {
    if (recent) return { snapshot: recent, backup: false };
    throw new Error("Usage unavailable");
  }
  let value;
  try {
    value = await transport.get(
      `/api/files/blob?path=${encodeURIComponent(USAGE_EXPORT_PATH)}`,
      signal,
    );
  } catch (error: unknown) {
    signal.throwIfAborted();
    if (recent && transport.status(error) === 404)
      return { snapshot: recent, backup: false };
    throw error;
  }
  signal.throwIfAborted();
  const backup = AiUsageBackupSchema.parse(value);
  if (backup.ownerId !== owner || !backup.report.history)
    throw new Error("Usage unavailable");
  return { snapshot: backup.report, backup: true };
}
