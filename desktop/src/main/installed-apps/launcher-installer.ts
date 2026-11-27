// Installs and uninstalls Windows and Linux launchers (spec 2711, layer 4).
// Order: icon, launcher, record; a failure undoes the earlier steps. The icon
// lives at `<userData>/installed-app-icons/<installId>.<ext>`, a path derived
// from the validated install id alone. Uninstall removes the launcher, icon,
// record and window state, never the app's files or data.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MacInstallRequestSchema, type MacInstallRequest } from "./mac-installer";
import { InstalledAppLimitError, MAX_INSTALLED_APPS, type InstalledAppStore } from "./record-store";
import { InstallIdSchema, type InstalledAppRecord } from "./record";

/** The sha256 recorded for an install without its own icon. */
const NO_ICON_SHA256 = createHash("sha256").update(new Uint8Array()).digest("hex");

export interface LauncherPlatform {
  iconExtension: "png" | "ico";
  encodeIcon(png: Uint8Array): Uint8Array;
  /** Writes the launcher and returns its path; never overwrites. */
  write(input: { installId: string; name: string; iconPath: string | null }): Promise<string>;
  /** Removes a launcher this platform wrote; refuses any other path. */
  remove(path: string): Promise<void>;
}

export interface LauncherInstallerOptions {
  records: InstalledAppStore;
  iconsDir: string;
  launcher: LauncherPlatform;
  /** The app's PNG icon, or null to use Matrix's own. */
  fetchIcon(slug: string): Promise<Uint8Array | null>;
  forgetWindowState(installId: string): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function createLauncherInstaller(options: LauncherInstallerOptions) {
  const { records, launcher } = options;
  const iconFile = (installId: string) => join(options.iconsDir, `${InstallIdSchema.parse(installId)}.${launcher.iconExtension}`);
  const removeIcon = (installId: string) => rm(iconFile(installId), { force: true });
  const cleanup = (label: string, task: () => Promise<unknown>) => task().catch((error: unknown) => logFailure(label, error));

  return {
    /** The icon file of an install, or null when it uses Matrix's icon. */
    iconPath(record: Pick<InstalledAppRecord, "installId" | "iconSha256">): string | null {
      return record.iconSha256 === NO_ICON_SHA256 ? null : iconFile(record.installId);
    },

    async install(request: MacInstallRequest): Promise<InstalledAppRecord> {
      const input = MacInstallRequestSchema.parse(request);
      // Refuse early; the record store re-checks the cap atomically.
      if ((await records.list()).length >= MAX_INSTALLED_APPS) throw new InstalledAppLimitError();
      const installId = randomUUID();
      const png = await options.fetchIcon(input.slug);
      let iconPath: string | null = null;
      let launcherPath: string | null = null;
      try {
        if (png) {
          await mkdir(options.iconsDir, { recursive: true });
          iconPath = iconFile(installId);
          await writeFile(iconPath, launcher.encodeIcon(png), { flag: "wx", mode: 0o644 });
        }
        launcherPath = await launcher.write({ installId, name: input.name, iconPath });
        return await records.create({
          ...input,
          iconSha256: createHash("sha256").update(png ?? new Uint8Array()).digest("hex"),
          bundlePath: launcherPath,
          cdHashes: [],
        }, { installId });
      } catch (error: unknown) {
        const written = launcherPath;
        if (written) await cleanup("launcher rollback failed", () => launcher.remove(written));
        if (iconPath) await cleanup("icon rollback failed", () => removeIcon(installId));
        throw error;
      }
    },

    async uninstall(installId: string): Promise<boolean> {
      const record = await records.get(installId);
      if (!record) return false;
      if (record.bundlePath) await launcher.remove(record.bundlePath);
      await cleanup("icon cleanup failed", () => removeIcon(record.installId));
      const removed = await records.remove(record.installId);
      await options.forgetWindowState(record.installId);
      return removed;
    },

    /** Start-up: forgets installs whose launcher the owner deleted. Returns their ids. */
    async prune(): Promise<string[]> {
      const pruned: string[] = [];
      for (const record of await records.list()) {
        if (!record.bundlePath) continue;
        try {
          await lstat(record.bundlePath);
          continue;
        } catch (error: unknown) {
          if (errorCode(error) !== "ENOENT") {
            logFailure("could not check an installed launcher", error);
            continue;
          }
        }
        if (await records.remove(record.installId)) {
          pruned.push(record.installId);
          await cleanup("icon cleanup failed", () => removeIcon(record.installId));
          await options.forgetWindowState(record.installId);
        }
      }
      return pruned;
    },
  };
}

export type LauncherInstaller = ReturnType<typeof createLauncherInstaller>;
