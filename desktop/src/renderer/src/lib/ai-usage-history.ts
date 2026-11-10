import { loadMatrixUsage as loadSharedUsage } from "@matrix-os/ui/ai-usage-load";
import { AppError } from "../../../shared/app-error";
import type { ApiClient } from "./api";
type Options = { syncedExport?: boolean; timeZone?: string };
/** Preserve recent counters on older runtimes; a paired completed sync reads its authoritative export. */
export function loadMatrixUsage(
  api: Pick<ApiClient, "get">,
  owner: string | null,
  signal: AbortSignal,
  options: Options = {},
) {
  if (!owner) return Promise.reject(new Error("Usage unavailable"));
  return loadSharedUsage(
    {
      get: (path, signal) =>
        api.get(path, {
          signal,
          timeoutMs: 65000,
          maxBytes: 16 * 1024 * 1024,
          cache: "no-store" as const,
        }),
      status: (error) =>
        error instanceof AppError ? error.httpStatus : undefined,
    },
    owner,
    signal,
    options,
  );
}
/** A failed Mac transfer must not hide history the Matrix computer can already serve. */
export async function loadDesktopUsage(input: {
  sync(): Promise<{ status: "synced" | "unpaired" }>;
  api: Pick<ApiClient, "get">;
  owner: string | null;
  signal: AbortSignal;
  timeZone?: string;
}) {
  let sync: "synced" | "unpaired" | "failed";
  try {
    sync = (await input.sync()).status;
  } catch (error: unknown) {
    input.signal.throwIfAborted();
    console.warn(
      "[ai-usage] Mac sync failed; showing Matrix history",
      error instanceof Error ? error.name : "UnknownError",
    );
    sync = "failed";
  }
  input.signal.throwIfAborted();
  const result = await loadMatrixUsage(input.api, input.owner, input.signal, {
    syncedExport: sync === "synced",
    timeZone: input.timeZone,
  });
  return { ...result, sync };
}
