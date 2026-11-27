// What the Install and Uninstall UI may do (spec 2711, layer 4), composed from
// the macOS installer or the Windows/Linux launchers. Electron-free.
//
// Availability changes during startup: the macOS shim server and the
// Windows/Linux launcher command resolve after the main window may already
// have asked. `runStartup` always reports a change when startup settles, so the
// renderer re-reads the list instead of keeping an early "unavailable".
import type { InstalledAppPlatform } from "../../shared/installed-apps-ipc";
import type { NativeAppOpenRequest, NativeAppOpenTarget } from "../../shared/native-app-open";
import { InstalledAppsUnavailableError, type InstalledAppsControl } from "./install-ipc";
import type { MacInstallRequest } from "./mac-installer";
import type { InstalledAppRecord } from "./record";

interface Installer {
  install(request: MacInstallRequest): Promise<InstalledAppRecord>;
  uninstall(installId: string): Promise<boolean>;
}

export interface InstallControlDeps {
  /** macOS shim installer (it closes the window and quits the shim itself, and reports its own changes). */
  mac: (Installer & { available(): boolean }) | null;
  /** Windows/Linux launchers; null until resolved, or when Matrix cannot be relaunched from a launcher. */
  launchers(): { platform: Exclude<InstalledAppPlatform, "mac">; installer: Installer } | null;
  records: { list(): Promise<InstalledAppRecord[]>; get(installId: string): Promise<InstalledAppRecord | null> };
  /** The authenticated catalog resolver. */
  resolveApp(request: NativeAppOpenRequest): Promise<NativeAppOpenTarget>;
  runtimeSlot(): string;
  closeWindow(installId: string): void;
  launch(installId: string): Promise<void>;
  reveal(path: string): void;
  onChanged(): void;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function createInstallControl(deps: InstallControlDeps) {
  const control: InstalledAppsControl = {
    platform: () => (deps.mac ? (deps.mac.available() ? "mac" : null) : deps.launchers()?.platform ?? null),
    list: () => deps.records.list(),

    async install(request) {
      const installer = deps.mac ?? deps.launchers()?.installer;
      if (!installer) throw new InstalledAppsUnavailableError();
      const target = await deps.resolveApp(request);
      const record = await installer.install({
        appIdentity: target.appIdentity, slug: target.slug, runtimeSlot: deps.runtimeSlot(), name: target.name,
      });
      deps.onChanged();
      void deps.launch(record.installId).catch((error: unknown) => logFailure("could not open the new app", error));
      return record;
    },

    async uninstall(installId) {
      if (deps.mac) return deps.mac.uninstall(installId);
      const launchers = deps.launchers();
      if (!launchers) throw new InstalledAppsUnavailableError();
      deps.closeWindow(installId);
      const removed = await launchers.installer.uninstall(installId);
      if (removed) deps.onChanged();
      return removed;
    },

    open: (installId) => deps.launch(installId),

    async show(installId) {
      const path = (await deps.records.get(installId))?.bundlePath;
      if (!path) return false;
      deps.reveal(path);
      return true;
    },
  };

  return {
    control,
    /** Runs startup, then reports a change whether it succeeded or not. */
    async runStartup(task: () => Promise<void>): Promise<void> {
      try {
        await task();
      } catch (error: unknown) {
        logFailure("installed apps startup failed", error);
      } finally {
        deps.onChanged();
      }
    },
  };
}
