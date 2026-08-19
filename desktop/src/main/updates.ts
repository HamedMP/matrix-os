// Auto-update (FR-091): packaged builds download in the background. Once the
// update is ready, the renderer offers the explicit restart-and-install action.
import { app } from "electron";
import {
  DesktopReleaseNotesSchema,
  DesktopUpdateVersionSchema,
  MAX_DESKTOP_RELEASE_NOTES_LENGTH,
  type DesktopReleaseNotes,
  type DesktopUpdateSnapshot,
  type DesktopUpdateStatus,
} from "../shared/desktop-update";
import { resolveUpdateFeedConfig } from "./update-config";

export type UpdateStatus = DesktopUpdateStatus;

interface UpdateEvents {
  onAvailable: (version: string) => void;
  onReady: (version: string) => void;
  onStateChanged?: (snapshot: DesktopUpdateSnapshot) => void;
  onReleaseReady?: (release: DesktopReleaseNotes) => Promise<void> | void;
}

const UPDATER_EVENT_NAMES = [
  "update-available",
  "download-progress",
  "update-downloaded",
  "update-not-available",
  "error",
] as const;

type ElectronAutoUpdater = typeof import("electron-updater")["autoUpdater"];

interface ElectronUpdaterModuleNamespace {
  autoUpdater?: unknown;
  default?: unknown;
}

export interface Updater {
  check(): Promise<void>;
  install(): Promise<boolean>;
  snapshot(): DesktopUpdateSnapshot;
  status(): UpdateStatus;
}

function hasAutoUpdaterShape(value: unknown): value is ElectronAutoUpdater {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.checkForUpdates === "function" &&
    typeof candidate.quitAndInstall === "function" &&
    typeof candidate.setFeedURL === "function" &&
    typeof candidate.removeAllListeners === "function" &&
    typeof candidate.once === "function" &&
    typeof candidate.on === "function"
  );
}

async function loadAutoUpdater(): Promise<ElectronAutoUpdater> {
  const updaterModule = await import("electron-updater") as ElectronUpdaterModuleNamespace;
  const directAutoUpdater = "autoUpdater" in updaterModule
    ? updaterModule.autoUpdater
    : undefined;
  const defaultExport = "default" in updaterModule
    ? updaterModule.default
    : undefined;
  const defaultAutoUpdater = defaultExport && typeof defaultExport === "object"
    ? (defaultExport as Record<string, unknown>).autoUpdater
    : undefined;
  const autoUpdater = directAutoUpdater ?? defaultAutoUpdater;
  if (!hasAutoUpdaterShape(autoUpdater)) {
    throw new Error("Desktop updater module is unavailable");
  }
  return autoUpdater;
}

function readVersion(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const parsed = DesktopUpdateVersionSchema.safeParse((info as { version?: unknown }).version);
  return parsed.success ? parsed.data : null;
}

function releaseNotesText(value: unknown): string {
  let notes = "";
  if (typeof value === "string") {
    notes = value;
  } else if (Array.isArray(value)) {
    notes = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return "";
        const note = (entry as { note?: unknown }).note;
        return typeof note === "string" ? note : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  const fallback = "This update includes the latest improvements and fixes.";
  return (notes.trim() || fallback).slice(0, MAX_DESKTOP_RELEASE_NOTES_LENGTH);
}

function readRelease(info: unknown, version: string): DesktopReleaseNotes {
  const candidate = info && typeof info === "object" ? info as {
    releaseDate?: unknown;
    releaseNotes?: unknown;
  } : {};
  const releaseDate = typeof candidate.releaseDate === "string"
    ? candidate.releaseDate
    : undefined;
  const parsed = DesktopReleaseNotesSchema.safeParse({
    version,
    ...(releaseDate ? { releaseDate } : {}),
    notes: releaseNotesText(candidate.releaseNotes),
  });
  if (parsed.success) return parsed.data;
  return { version, notes: releaseNotesText(candidate.releaseNotes) };
}

export function createUpdater(events: UpdateEvents): Updater {
  let current: DesktopUpdateSnapshot = { status: "disabled" };
  let activeAutoUpdater: ElectronAutoUpdater | null = null;
  let pendingReleaseSave: Promise<void> = Promise.resolve();
  const feed = resolveUpdateFeedConfig(process.env, app.isPackaged);

  const setSnapshot = (next: DesktopUpdateSnapshot): void => {
    current = next;
    events.onStateChanged?.({ ...current });
  };

  const updater: Updater = {
    async check() {
      if (!feed.enabled) {
        setSnapshot({ status: "disabled" });
        return;
      }
      if (
        current.status === "checking" ||
        current.status === "downloading" ||
        current.status === "ready"
      ) return;

      setSnapshot({ status: "checking" });
      try {
        const autoUpdater = await loadAutoUpdater();
        activeAutoUpdater = autoUpdater;
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
          const version = readVersion(info);
          if (!version) {
            setSnapshot({ status: "error" });
            return;
          }
          setSnapshot({ status: "downloading", version, progress: 0 });
          events.onAvailable(version);
        });
        autoUpdater.on("download-progress", (progress) => {
          if (current.status !== "downloading") return;
          const rawPercent = Number(progress.percent);
          const percent = Number.isFinite(rawPercent)
            ? Math.min(100, Math.max(0, rawPercent))
            : current.progress ?? 0;
          setSnapshot({ ...current, progress: percent });
        });
        autoUpdater.once("update-downloaded", (info) => {
          const version = readVersion(info);
          if (!version) {
            setSnapshot({ status: "error" });
            return;
          }
          setSnapshot({ status: "ready", version, progress: 100 });
          events.onReady(version);
          pendingReleaseSave = Promise.resolve(events.onReleaseReady?.(readRelease(info, version)))
            .catch((err: unknown) => {
              console.warn(
                "[updates] could not persist release notes:",
                err instanceof Error ? err.message : String(err),
              );
            });
        });
        autoUpdater.once("update-not-available", () => {
          setSnapshot({ status: "up-to-date" });
        });
        autoUpdater.once("error", (err) => {
          console.warn(
            "[updates] download failed:",
            err instanceof Error ? err.message : String(err),
          );
          setSnapshot({ status: "error" });
        });
        await autoUpdater.checkForUpdates();
      } catch (err: unknown) {
        console.warn(
          "[updates] check failed:",
          err instanceof Error ? err.message : String(err),
        );
        setSnapshot({ status: "error" });
      }
    },
    async install() {
      if (current.status !== "ready") return false;
      await pendingReleaseSave;
      const installable = activeAutoUpdater ?? await loadAutoUpdater();
      activeAutoUpdater = installable;
      installable.quitAndInstall(false, true);
      return true;
    },
    snapshot: () => ({ ...current }),
    status: () => current.status,
  };

  return updater;
}
