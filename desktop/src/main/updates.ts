// Auto-update (FR-091): background download, apply on relaunch, never
// force-restarts attached work. Packaged builds default to GitHub release
// manifests; OPERATOR_UPDATE_FEED remains as a generic-provider override.
import { app } from "electron";
import { resolveUpdateFeedConfig } from "./update-config";

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
  const feed = resolveUpdateFeedConfig(process.env, app.isPackaged);

  if (!feed.enabled) {
    return {
      check: async () => {
        status = "disabled";
      },
      status: () => status,
    };
  }

  return {
    async check() {
      if (status === "downloading") return;
      status = "checking";
      try {
        const { autoUpdater } = await import("electron-updater");
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.allowPrerelease = feed.allowPrerelease;
        if (feed.provider === "generic") {
          autoUpdater.setFeedURL({ provider: "generic", url: feed.url });
        } else {
          autoUpdater.setFeedURL({
            provider: "github",
            owner: feed.owner,
            repo: feed.repo,
            ...(feed.channel === "stable" ? {} : { channel: feed.channel }),
          });
        }
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
