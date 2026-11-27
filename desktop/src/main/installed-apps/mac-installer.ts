// Writes and removes installed-app shim bundles in `~/Applications/Matrix Apps/`
// (spec 2711, layer 3). A bundle is written in full in a private temp
// directory, its cdhash is read, and only then is it moved into a freshly
// reserved name: macOS App Management denies edits after a bundle's first
// launch, and an existing path is never overwritten. Every path it deletes is
// resolved strictly inside the Matrix Apps folder, and symlinks are never followed.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  BUNDLE_TEMP_PREFIX,
  SHIM_EXECUTABLE,
  bundleDisplayName,
  bundleFileName,
  shimBundleFiles,
} from "./mac-bundle";
import { InstalledAppLimitError, MAX_INSTALLED_APPS, type InstalledAppStore } from "./record-store";
import { NewInstalledAppSchema, type InstalledAppRecord } from "./record";

const MAX_NAME_ATTEMPTS = 50;

export const MacInstallRequestSchema = NewInstalledAppSchema.pick({ appIdentity: true, slug: true, runtimeSlot: true, name: true });
export type MacInstallRequest = z.infer<typeof MacInstallRequestSchema>;

export class InstalledAppBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstalledAppBundleError";
  }
}

export interface MacInstallerOptions {
  /** `~/Applications/Matrix Apps`. */
  appsDir: string;
  records: InstalledAppStore;
  host: { appPath: string; bundleId: string; serverName: string; hostArguments: readonly string[]; loaderPath: string };
  /** `.icns` bytes for the app (falls back to the Matrix icon itself). */
  makeIcon(slug: string): Promise<Uint8Array>;
  /** `codesign -dvvv` CDHash values of an executable. */
  readCdHashes(executablePath: string): Promise<string[]>;
  forgetWindowState(installId: string): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function createMacInstaller(options: MacInstallerOptions) {
  const appsDir = resolve(options.appsDir);

  /**
   * The Matrix Apps folder's real path (null when it does not exist). A
   * launched shim reports its real bundle path (macOS `/tmp` is `/private/tmp`),
   * so records hold real paths. The folder itself must not be a symlink.
   */
  async function requireAppsDir(create: boolean): Promise<string | null> {
    if (create) await mkdir(appsDir, { recursive: true });
    try {
      const info = await lstat(appsDir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new InstalledAppBundleError("Matrix Apps folder is not a folder");
      return await realpath(appsDir);
    } catch (error: unknown) {
      if (!create && errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  /** A recorded bundle path, only when it is a direct `.app` child of the Matrix Apps folder. */
  function ownedBundlePath(bundlePath: string, root: string): string {
    const path = resolve(bundlePath);
    const name = basename(path);
    if (dirname(path) !== root || !name.endsWith(".app") || name.startsWith(".")) {
      throw new InstalledAppBundleError("Bundle is outside the Matrix Apps folder");
    }
    return path;
  }

  async function writeBundle(dir: string, installId: string, displayName: string, icon: Uint8Array): Promise<void> {
    const files = shimBundleFiles({
      installId,
      displayName,
      hostPath: options.host.appPath,
      hostBundleId: options.host.bundleId,
      serverName: options.host.serverName,
      hostArguments: options.host.hostArguments,
      loaderPath: options.host.loaderPath,
      icon,
    });
    for (const file of files) {
      const target = join(dir, file.path);
      await mkdir(dirname(target), { recursive: true });
      if ("copyFrom" in file) await copyFile(file.copyFrom, target, constants.COPYFILE_EXCL);
      else await writeFile(target, file.contents, { flag: "wx" });
      await chmod(target, file.mode);
    }
  }

  /** Claims `Name.app`, `Name 2.app`… with an exclusive mkdir; the empty directory is replaced by the rename. */
  async function reserveBundlePath(root: string, displayName: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      const path = join(root, bundleFileName(displayName, attempt));
      try {
        await mkdir(path);
        return path;
      } catch (error: unknown) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    throw new InstalledAppBundleError("No free bundle name");
  }

  async function cleanup(label: string, task: () => Promise<unknown>): Promise<void> {
    await task().catch((error: unknown) => logFailure(label, error));
  }

  return {
    async install(request: MacInstallRequest): Promise<InstalledAppRecord> {
      const input = MacInstallRequestSchema.parse(request);
      // Refuse early; the record store re-checks the cap atomically.
      if ((await options.records.list()).length >= MAX_INSTALLED_APPS) throw new InstalledAppLimitError();
      const root = (await requireAppsDir(true))!;
      const installId = randomUUID();
      const displayName = bundleDisplayName(input.name);
      const temp = await mkdtemp(join(root, BUNDLE_TEMP_PREFIX));
      let reserved: string | null = null;
      let record: InstalledAppRecord | null = null;
      try {
        const icon = await options.makeIcon(input.slug);
        await writeBundle(temp, installId, displayName, icon);
        const cdHashes = await options.readCdHashes(join(temp, "Contents/MacOS", SHIM_EXECUTABLE));
        if (cdHashes.length === 0) throw new InstalledAppBundleError("Shim has no code signature to pin");
        reserved = await reserveBundlePath(root, displayName);
        record = await options.records.create({
          ...input,
          iconSha256: createHash("sha256").update(icon).digest("hex"),
          bundlePath: reserved,
          cdHashes,
        }, { installId });
        await rename(temp, reserved);
        return record;
      } catch (error: unknown) {
        await cleanup("temp bundle cleanup failed", () => rm(temp, { recursive: true, force: true }));
        if (record) await cleanup("install record rollback failed", () => options.records.remove(installId));
        const path = reserved;
        if (path) {
          // rmdir only removes the still-empty reservation, never a moved bundle.
          await cleanup("bundle reservation cleanup failed", () => rmdir(path).catch((rmdirError: unknown) => {
            if (errorCode(rmdirError) !== "ENOENT") throw rmdirError;
          }));
        }
        throw error;
      }
    },

    /** Removes the bundle, the record and the window state; never the app's files or data. */
    async uninstall(installId: string): Promise<boolean> {
      const record = await options.records.get(installId);
      if (!record) return false;
      if (record.bundlePath) {
        const root = await requireAppsDir(false);
        // Without the folder there is nothing to delete, but the recorded path must still be ours.
        const path = ownedBundlePath(record.bundlePath, root ?? appsDir);
        if (root) {
          try {
            const info = await lstat(path);
            if (info.isSymbolicLink() || !info.isDirectory()) throw new InstalledAppBundleError("Bundle is not a folder");
            await rm(path, { recursive: true });
          } catch (error: unknown) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        }
      }
      const removed = await options.records.remove(record.installId);
      await options.forgetWindowState(record.installId);
      return removed;
    },

    /** Start-up: deletes temp bundles left by a crash and empty name reservations. */
    async sweep(): Promise<void> {
      const root = await requireAppsDir(false);
      if (!root) return;
      for (const name of await readdir(root)) {
        const path = join(root, name);
        const info = await lstat(path).catch((error: unknown) => {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        });
        if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
        if (name.startsWith(BUNDLE_TEMP_PREFIX)) {
          await cleanup("stale temp bundle cleanup failed", () => rm(path, { recursive: true, force: true }));
        } else if (name.endsWith(".app")) {
          await rmdir(path).catch((error: unknown) => {
            if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") logFailure("empty bundle cleanup failed", error);
          });
        }
      }
    },

    /** Start-up: forgets installs whose bundle the owner moved or deleted. Returns their ids. */
    async prune(): Promise<string[]> {
      const pruned: string[] = [];
      for (const record of await options.records.list()) {
        if (!record.bundlePath) continue;
        try {
          await lstat(record.bundlePath);
          continue;
        } catch (error: unknown) {
          if (errorCode(error) !== "ENOENT") {
            logFailure("could not check an installed bundle", error);
            continue;
          }
        }
        if (await options.records.remove(record.installId)) {
          pruned.push(record.installId);
          await options.forgetWindowState(record.installId);
        }
      }
      return pruned;
    },
  };
}

export type MacInstaller = ReturnType<typeof createMacInstaller>;
