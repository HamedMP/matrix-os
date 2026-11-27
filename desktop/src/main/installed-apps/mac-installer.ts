// Writes and removes installed-app shim bundles in `~/Applications/Matrix Apps/`
// (spec 2711, layer 3). A bundle is written in full in a private temp
// directory, signed ad hoc there (which seals its Info.plist and gives it its
// own cdhash), verified, and its cdhash read; only then is it moved into a
// freshly reserved name: macOS App Management denies edits after a bundle's
// first launch, and an existing path is never overwritten. Every path it deletes is
// resolved strictly inside the Matrix Apps folder, and symlinks are never followed.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  BUNDLE_TEMP_PREFIX,
  SHIM_ENTITLEMENTS,
  bundleDisplayName,
  bundleFileName,
  bundleTempOwner,
  bundleTempPrefix,
  parseCdHashes,
  shimBundleFiles,
  shimBundleIdentifier,
} from "./mac-bundle";
import type { RunTool } from "./mac-host";
import { InstalledAppLimitError, MAX_INSTALLED_APPS, type InstalledAppStore } from "./record-store";
import { NewInstalledAppSchema, type InstalledAppRecord } from "./record";

const MAX_NAME_ATTEMPTS = 50;
const CODESIGN = "/usr/bin/codesign";
const SIGN_TIMEOUT_MS = 30_000;
/** Another channel's temp folder is swept only when its owner is gone and it has sat this long. */
const STALE_TEMP_MS = 10 * 60_000;
const MAX_INFO_PLIST_BYTES = 64 * 1024;

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
  /** Runs `/usr/bin/codesign` (execFile, no shell). */
  codesign: RunTool;
  forgetWindowState(installId: string): Promise<void>;
  /** Whether a temp folder's writer still runs; default `process.kill(pid, 0)`. */
  isProcessAlive?(pid: number): boolean;
  now?(): number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: it runs as another user, so it is alive.
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}


function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function createMacInstaller(options: MacInstallerOptions) {
  const appsDir = resolve(options.appsDir);
  const isProcessAlive = options.isProcessAlive ?? processAlive;
  const now = options.now ?? Date.now;
  const tempPrefix = bundleTempPrefix(options.host.serverName, process.pid);

  /**
   * Stable, Canary and dev share the Matrix Apps folder. A temp folder is ours
   * to sweep when this channel wrote it in an earlier run, or when its writer
   * is gone and it is stale. Folders without an owner count as gone.
   */
  function sweepable(name: string, mtimeMs: number): boolean {
    const owner = bundleTempOwner(name);
    if (owner?.pid === process.pid) return false;
    if (owner?.server === options.host.serverName) return true;
    const gone = !owner || !isProcessAlive(owner.pid);
    return gone && now() - mtimeMs > STALE_TEMP_MS;
  }

  /** The bundle id in a bundle's Info.plist; null when it has none we can read. */
  async function bundleIdAt(path: string): Promise<string | null> {
    const plistPath = join(path, "Contents/Info.plist");
    const info = await lstat(plistPath);
    if (!info.isFile() || info.size > MAX_INFO_PLIST_BYTES) return null;
    const plist = await readFile(plistPath, "utf8");
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
  }

  /** True only when the bundle at `path` carries this install's bundle id and recorded cdhash. */
  async function isThisInstall(path: string, record: InstalledAppRecord): Promise<boolean> {
    try {
      if (await bundleIdAt(path) !== shimBundleIdentifier(record.installId)) return false;
      const { stdout, stderr } = await options.codesign(CODESIGN, ["-dvvv", path], { signal: AbortSignal.timeout(SIGN_TIMEOUT_MS) });
      return parseCdHashes(`${stdout}\n${stderr}`).some((hash) => record.cdHashes.includes(hash));
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") logFailure("could not check an installed bundle", error);
      return false;
    }
  }

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

  /**
   * Signs the complete, never-launched bundle ad hoc with the hardened runtime
   * and only the library-validation entitlement, verifies it, and returns its
   * own cdhash. Any failure aborts the install.
   */
  async function signBundle(temp: string, bundle: string): Promise<string[]> {
    const entitlements = join(temp, "entitlements.plist");
    const run = (args: string[]) => options.codesign(CODESIGN, args, { signal: AbortSignal.timeout(SIGN_TIMEOUT_MS) });
    try {
      await writeFile(entitlements, SHIM_ENTITLEMENTS, { flag: "wx", mode: 0o644 });
      await run(["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, bundle]);
      await run(["--verify", "--strict", bundle]);
      const { stdout, stderr } = await run(["-dvvv", bundle]);
      const cdHashes = parseCdHashes(`${stdout}\n${stderr}`);
      if (cdHashes.length > 0) return cdHashes;
      throw new InstalledAppBundleError("Shim has no code signature to pin");
    } catch (error: unknown) {
      logFailure("shim signing failed", error);
      throw new InstalledAppBundleError("Shim could not be signed");
    } finally {
      await cleanup("entitlements cleanup failed", () => rm(entitlements, { force: true }));
    }
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
      const temp = await mkdtemp(join(root, tempPrefix));
      let reserved: string | null = null;
      let record: InstalledAppRecord | null = null;
      try {
        const icon = await options.makeIcon(input.slug);
        const bundle = join(temp, "Shim.app");
        await writeBundle(bundle, installId, displayName, icon);
        const cdHashes = await signBundle(temp, bundle);
        reserved = await reserveBundlePath(root, displayName);
        record = await options.records.create({
          ...input,
          iconSha256: createHash("sha256").update(icon).digest("hex"),
          bundlePath: reserved,
          cdHashes,
        }, { installId });
        await rename(bundle, reserved);
        await cleanup("temp folder cleanup failed", () => rm(temp, { recursive: true, force: true }));
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
            // The owner may have moved this bundle and a new install taken its name: delete only our own.
            if (await isThisInstall(path, record)) await rm(path, { recursive: true });
            else console.warn("[installed-apps] recorded bundle path holds another app; forgetting the record only");
          } catch (error: unknown) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        }
      }
      const removed = await options.records.remove(record.installId);
      await options.forgetWindowState(record.installId);
      return removed;
    },

    /** Start-up: deletes temp bundles left by a crash (see `sweepable`) and empty name reservations. */
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
          if (!sweepable(name, info.mtimeMs)) continue;
          await cleanup("stale temp bundle cleanup failed", () => rm(path, { recursive: true, force: true }));
        } else if (name.endsWith(".app")) {
          await rmdir(path).catch((error: unknown) => {
            if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") logFailure("empty bundle cleanup failed", error);
          });
        }
      }
    },

    /**
     * Start-up: forgets installs whose bundle the owner moved or deleted,
     * including one whose path now holds another install's bundle (left in
     * place). Returns their ids.
     */
    async prune(): Promise<string[]> {
      const pruned: string[] = [];
      for (const record of await options.records.list()) {
        if (!record.bundlePath) continue;
        try {
          await lstat(record.bundlePath);
          if (await bundleIdAt(record.bundlePath) === shimBundleIdentifier(record.installId)) continue;
        } catch (error: unknown) {
          // ENOENT: the bundle, or its Info.plist, is gone. Anything else: keep the record.
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
