import type {
  InstalledSyncHelper,
  InstalledSyncHelperRecord,
} from "./sync-helper-installer";
import type { SyncHelperCommandRunner } from "./sync-helper-service";

function previousHelper(previous: InstalledSyncHelperRecord): InstalledSyncHelper {
  return { ...previous, source: "current" };
}

function daemonReady(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const data = (result as { data?: unknown }).data;
  return Boolean(data && typeof data === "object" && (data as { running?: unknown }).running === true);
}

export async function activateSyncHelperUpgrade(
  installed: InstalledSyncHelper,
  deps: {
    run: SyncHelperCommandRunner;
    restore: (previous: InstalledSyncHelperRecord) => Promise<void>;
    wait?: (ms: number) => Promise<void>;
    attempts?: number;
  },
): Promise<void> {
  if (installed.source !== "packaged" || !installed.previous) return;
  const previous = previousHelper(installed.previous);
  const wait = deps.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = deps.attempts ?? 10;
  try {
    await deps.run(previous, ["sync", "pause", "--json", "--profile", "desktop"])
      .catch(() => undefined);
    await deps.run(installed, ["__desktop-activate"]);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (daemonReady(await deps.run(installed, ["sync", "status", "--json", "--profile", "desktop"])
        .catch(() => null))) {
        return;
      }
      await wait(200);
    }
    throw new Error("sync_helper_upgrade_not_ready");
  } catch {
    await deps.restore(installed.previous);
    await deps.run(previous, ["__desktop-activate"]).catch(() => undefined);
    throw new Error("sync_helper_upgrade_failed");
  }
}
