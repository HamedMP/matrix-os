// Composes install records, the window controller and each window's content
// host. Electron-free: the Electron window and app view are injected.
import type { FittedWindowBounds, WindowBounds } from "../platform/window-bounds";
import {
  createInstalledAppWindowController,
  type InstalledAppOpenContext,
  type InstalledAppOpenResult,
  type InstalledAppWindowLike,
} from "./controller";
import type { InstalledAppAuthSnapshot } from "./app-host";
import type { InstalledAppRecord } from "./record";

export interface InstalledAppHostLike {
  load(): Promise<void>;
  authChanged(status: InstalledAppAuthSnapshot): void;
  dispose(): void;
}

export interface InstalledAppsServiceOptions<W extends InstalledAppWindowLike> {
  records: { get(installId: string): Promise<InstalledAppRecord | null> };
  windowState: {
    load(installId: string): Promise<Required<WindowBounds> | null>;
    save(installId: string, bounds: Required<WindowBounds>): Promise<void>;
  };
  fitBounds(bounds: WindowBounds): FittedWindowBounds;
  createWindow(record: InstalledAppRecord, bounds: FittedWindowBounds, context: InstalledAppOpenContext): { window: W; host: InstalledAppHostLike };
}

export function createInstalledAppsService<W extends InstalledAppWindowLike>(options: InstalledAppsServiceOptions<W>) {
  // Bounded by the controller's open-window cap: one entry per live window.
  const hosts = new Map<string, InstalledAppHostLike>();
  const controller = createInstalledAppWindowController<W>({
    getRecord: (installId) => options.records.get(installId),
    loadBounds: (installId) => options.windowState.load(installId),
    saveBounds: (installId, bounds) => options.windowState.save(installId, bounds),
    fitBounds: options.fitBounds,
    create: (record, bounds, context) => {
      const { window, host } = options.createWindow(record, bounds, context);
      hosts.get(record.installId)?.dispose();
      hosts.set(record.installId, host);
      window.on("closed", () => {
        host.dispose();
        if (hosts.get(record.installId) === host) hosts.delete(record.installId);
      });
      void host.load().catch((error: unknown) => {
        console.warn("[installed-apps] app window load failed:", error instanceof Error ? error.name : "UnknownError");
      });
      return window;
    },
  });

  return {
    async open(installId: string, context: InstalledAppOpenContext = {}): Promise<InstalledAppOpenResult> {
      const result = await controller.openOrFocus(installId, context);
      if (result === "limit" || result === "not-installed" || result === "unavailable") {
        console.warn("[installed-apps] app window not opened:", result);
      }
      return result;
    },

    shimOf: (installId: string) => controller.shimOf(installId),
    window: (installId: string): W | null => controller.current(installId),
    openInstallIds: () => controller.installIds(),
    saveNow: (installId: string) => controller.saveNow(installId),

    /** Reloads an open window's content; false when the install has no window. */
    reload(installId: string): boolean {
      const host = controller.current(installId) ? hosts.get(installId) : undefined;
      if (!host) return false;
      void host.load().catch((error: unknown) => {
        console.warn("[installed-apps] app window reload failed:", error instanceof Error ? error.name : "UnknownError");
      });
      return true;
    },

    close(installId: string): void {
      controller.closeWhere((candidate) => candidate === installId);
    },

    /** Sign-out, sign-in or runtime switch. */
    authChanged(status: InstalledAppAuthSnapshot): void {
      for (const host of [...hosts.values()]) host.authChanged(status);
    },

    /** Quit: close windows and wait until their window state is written. */
    dispose(): Promise<void> {
      return controller.dispose();
    },
  };
}
