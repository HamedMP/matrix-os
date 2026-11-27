// Installed apps open at quit are reopened by the next start (spec 2711
// "Integration Wiring"): only within 15 minutes, at most 16, four at a time.
import { z } from "zod/v4";
import { MAX_INSTALLED_APP_WINDOWS } from "./controller";
import { InstallIdSchema } from "./record";

export const REOPEN_TTL_MS = 15 * 60_000;
export const MAX_REOPEN_APPS = MAX_INSTALLED_APP_WINDOWS;
export const REOPEN_CONCURRENCY = 4;

export const InstalledAppsReopenSchema = z.strictObject({
  savedAt: z.number().int().nonnegative(),
  installIds: z.array(InstallIdSchema).max(MAX_REOPEN_APPS),
});
export type InstalledAppsReopenState = z.infer<typeof InstalledAppsReopenSchema>;

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function createInstalledAppReopen(options: {
  store: { get(): Promise<unknown>; set(value: InstalledAppsReopenState): Promise<void>; delete(): Promise<void> };
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return {
    /** Quit: remembers the open apps (or that none were open). */
    async save(installIds: readonly string[]): Promise<void> {
      const ids = [...new Set(installIds)].filter((id) => InstallIdSchema.safeParse(id).success).slice(0, MAX_REOPEN_APPS);
      if (ids.length === 0) await options.store.delete();
      else await options.store.set({ savedAt: now(), installIds: ids });
    },

    /** Start-up: the apps to reopen, at most once per quit. */
    async take(): Promise<string[]> {
      let saved: unknown;
      try {
        saved = await options.store.get();
        if (saved !== null) await options.store.delete();
      } catch (error: unknown) {
        logFailure("reopen list unavailable", error);
        return [];
      }
      const parsed = InstalledAppsReopenSchema.safeParse(saved);
      if (!parsed.success) return [];
      const age = now() - parsed.data.savedAt;
      return age >= 0 && age <= REOPEN_TTL_MS ? parsed.data.installIds : [];
    },
  };
}

/** Runs `open` for each install, `REOPEN_CONCURRENCY` at a time; one failure does not stop the rest. */
export async function reopenEach(installIds: readonly string[], open: (installId: string) => Promise<unknown>): Promise<void> {
  const queue = [...installIds];
  const worker = async () => {
    for (let installId = queue.shift(); installId !== undefined; installId = queue.shift()) {
      await open(installId).catch((error: unknown) => logFailure("could not reopen an app", error));
    }
  };
  await Promise.all(Array.from({ length: Math.min(REOPEN_CONCURRENCY, queue.length) }, worker));
}
