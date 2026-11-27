// What the Install and Uninstall UI may do (spec 2711, layer 4), composed from
// the macOS installer or the Windows/Linux launchers. Electron-free.
//
// The control object exists before installed apps are wired, so the IPC can
// take it at registration; `bind` wires it once. It reports "unavailable"
// until it is bound and startup has settled (the macOS shim server and the
// Windows/Linux launcher command resolve after the main window may already
// have asked). `runStartup` always reports a change when startup settles, so
// the renderer re-reads the list instead of keeping an early "unavailable".
import type { InstalledAppPlatform } from "../../shared/installed-apps-ipc";
import type { NativeAppOpenRequest, NativeAppOpenTarget } from "../../shared/native-app-open";
import { NativeAppOpenError } from "../embeds/native-app-open";
import { InstalledAppSessionChangedError, InstalledAppsUnavailableError, type InstalledAppsControl } from "./install-ipc";
import type { MacInstallRequest } from "./mac-installer";
import type { InstalledAppRecord } from "./record";

interface Installer {
  install(request: MacInstallRequest): Promise<InstalledAppRecord>;
  uninstall(installId: string): Promise<boolean>;
}

export interface InstallSession {
  signedIn: boolean;
  runtimeSlot: string;
  authGeneration: number;
}

export interface InstallControlDeps {
  /** macOS shim installer (it closes the window and quits the shim itself, and reports its own changes). */
  mac: (Installer & { available(): boolean }) | null;
  /** Windows/Linux launchers; null until resolved, or when Matrix cannot be relaunched from a launcher. */
  launchers(): { platform: Exclude<InstalledAppPlatform, "mac">; installer: Installer } | null;
  records: { list(): Promise<InstalledAppRecord[]>; get(installId: string): Promise<InstalledAppRecord | null> };
  /** The authenticated catalog resolver. */
  resolveApp(request: NativeAppOpenRequest): Promise<NativeAppOpenTarget>;
  /** The current Matrix session: which computer, and which sign-in. */
  session(): InstallSession;
  closeWindow(installId: string): void;
  launch(installId: string): Promise<void>;
  reveal(path: string): void;
  onChanged(): void;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

function sameSession(a: InstallSession, b: InstallSession): boolean {
  return a.signedIn === b.signedIn && a.runtimeSlot === b.runtimeSlot && a.authGeneration === b.authGeneration;
}

export function createInstallControl() {
  let deps: InstallControlDeps | null = null;
  let started = false;
  /** Deps once bound and started; null means "unavailable". */
  const live = () => (started ? deps : null);

  const control: InstalledAppsControl = {
    platform() {
      const d = live();
      if (!d) return null;
      return d.mac ? (d.mac.available() ? "mac" : null) : d.launchers()?.platform ?? null;
    },

    list: async () => (await live()?.records.list()) ?? [],

    async install(request) {
      const d = live();
      const installer = d?.mac ?? d?.launchers()?.installer;
      if (!d || !installer) throw new InstalledAppsUnavailableError();
      // The install belongs to the computer it was asked on: capture it before the catalog round trip.
      const before = d.session();
      if (!before.signedIn) throw new NativeAppOpenError("auth-required", "desktop authentication required");
      const target = await d.resolveApp(request);
      const after = d.session();
      if (!after.signedIn) throw new NativeAppOpenError("auth-required", "desktop authentication required");
      if (!sameSession(before, after)) throw new InstalledAppSessionChangedError();
      const record = await installer.install({
        appIdentity: target.appIdentity, slug: target.slug, runtimeSlot: before.runtimeSlot, name: target.name,
      });
      d.onChanged();
      void d.launch(record.installId).catch((error: unknown) => logFailure("could not open the new app", error));
      return record;
    },

    async uninstall(installId) {
      const d = live();
      if (d?.mac) return d.mac.uninstall(installId);
      const launchers = d?.launchers();
      if (!d || !launchers) throw new InstalledAppsUnavailableError();
      d.closeWindow(installId);
      const removed = await launchers.installer.uninstall(installId);
      if (removed) d.onChanged();
      return removed;
    },

    async open(installId) {
      await live()?.launch(installId);
    },

    async show(installId) {
      const d = live();
      const path = d ? (await d.records.get(installId))?.bundlePath : null;
      if (!d || !path) return false;
      d.reveal(path);
      return true;
    },
  };

  return {
    control,
    /** Wires the control to installed apps, once. */
    bind(next: InstallControlDeps): void {
      if (deps) throw new Error("Installed apps are already wired");
      deps = next;
    },
    /** Runs startup, then marks the control available and reports a change, whether startup succeeded or not. */
    async runStartup(task: () => Promise<void>): Promise<void> {
      try {
        await task();
      } catch (error: unknown) {
        logFailure("installed apps startup failed", error);
      } finally {
        started = deps !== null;
        deps?.onChanged();
      }
    },
  };
}

export type InstallControl = ReturnType<typeof createInstallControl>;
