// Composes install records, the window controller and each window's content
// host. Electron-free: the Electron window and app view are injected.
import type { FittedWindowBounds, WindowBounds } from "../platform/window-bounds";
import { createInstalledAppWindowController, type InstalledAppOpenResult, type InstalledAppWindowLike } from "./controller";
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
  createWindow(record: InstalledAppRecord, bounds: FittedWindowBounds): { window: W; host: InstalledAppHostLike };
}

export function createInstalledAppsService<W extends InstalledAppWindowLike>(options: InstalledAppsServiceOptions<W>) {
  // Bounded by the controller's open-window cap: one entry per live window.
  const hosts = new Map<string, InstalledAppHostLike>();
  const controller = createInstalledAppWindowController<W>({
    getRecord: (installId) => options.records.get(installId),
    loadBounds: (installId) => options.windowState.load(installId),
    saveBounds: (installId, bounds) => options.windowState.save(installId, bounds),
    fitBounds: options.fitBounds,
    create: (record, bounds) => {
      const { window, host } = options.createWindow(record, bounds);
      hosts.set(record.installId, host);
      window.on("closed", () => {
        if (hosts.get(record.installId) !== host) return;
        hosts.delete(record.installId);
        host.dispose();
      });
      void host.load().catch((error: unknown) => {
        console.warn("[installed-apps] app window load failed:", error instanceof Error ? error.name : "UnknownError");
      });
      return window;
    },
  });

  return {
    async open(installId: string): Promise<InstalledAppOpenResult> {
      const result = await controller.openOrFocus(installId);
      if (result === "limit" || result === "not-installed" || result === "unavailable") {
        console.warn("[installed-apps] app window not opened:", result);
      }
      return result;
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
