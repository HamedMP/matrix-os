// Auto-update (FR-091): background download, apply on relaunch, never
// force-restarts attached work. No-ops cleanly until the desktop release feed
// (gateway delta #4) exists and the build is signed.
import { app } from "electron";

export type UpdateStatus =
  | "disabled"
  | "checking"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "error";

interface UpdateEvents {
  onAvailable: (version: string) => void;
  onReady: (version: string) => void;
}

const UPDATER_EVENT_NAMES = [
  "update-available",
  "update-downloaded",
  "update-not-available",
] as const;

export interface Updater {
  check(): Promise<void>;
  status(): UpdateStatus;
}

export function createUpdater(events: UpdateEvents): Updater {
  let status: UpdateStatus = "disabled";
  const feedConfigured = Boolean(process.env.OPERATOR_UPDATE_FEED) && app.isPackaged;

  if (!feedConfigured) {
    return {
      check: async () => {
        status = "disabled";
      },
      status: () => status,
    };
  }

  return {
    async check() {
      status = "checking";
      try {
        const { autoUpdater } = await import("electron-updater");
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.setFeedURL({ provider: "generic", url: process.env.OPERATOR_UPDATE_FEED! });
        for (const eventName of UPDATER_EVENT_NAMES) {
          autoUpdater.removeAllListeners(eventName);
        }
        autoUpdater.once("update-available", (info) => {
          status = "downloading";
          events.onAvailable(info.version);
        });
        autoUpdater.once("update-downloaded", (info) => {
          status = "ready";
          events.onReady(info.version);
        });
        autoUpdater.once("update-not-available", () => {
          status = "up-to-date";
        });
        await autoUpdater.checkForUpdates();
      } catch (err: unknown) {
        console.warn(
          "[updates] check failed:",
          err instanceof Error ? err.message : String(err),
        );
        status = "error";
      }
    },
    status: () => status,
  };
}
