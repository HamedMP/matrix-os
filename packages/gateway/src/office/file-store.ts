import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appFileVersion } from "@matrix-os/contracts/app-files";
import { hasSymlinkComponent, lstatOrNull } from "../app-files/paths.js";
import { unguardedProjectWrite, type ProjectWriteGuard } from "../app-files/project-write-fence.js";
import { withOwnerFileMutation } from "../owner-file-mutations.js";
import {
  isDeniedFileApiPath, isProtectedHomeSubpath, resolveExistingFileApiPath, resolveWithinHome, resolveWritableFileApiPath,
} from "../path-security.js";
import { OfficeDocumentError, errnoCode } from "./errors.js";

/** Prefix of the temporary file a save publishes from, in the target's directory. */
export const OFFICE_TEMP_PREFIX = ".matrix-office-";

export interface OfficeFileStoreOptions {
  homePath: string;
  maxFileBytes: number;
  /** Runs after an edit is computed and before the version check and publish. A test seam for racing saves. */
  beforeCommit?: (absolutePath: string) => Promise<void>;
  /** The collaboration project fence; a save into a shared or mid-transition project is refused. */
  writeGuard?: ProjectWriteGuard;
}

export interface LoadedOfficeFile {
  path: string;
  absolutePath: string;
  bytes: Uint8Array;
  version: string;
}

export interface CommittedOfficeFile {
  path: string;
  version: string;
  size: number;
}

function callPathHelper(helper: () => string | null): string | null {
  try { return helper(); }
  catch (error: unknown) {
    // The File API helpers use sync fs; a racing delete surfaces here.
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function removeTemp(path: string): Promise<void> {
  try { await rm(path, { force: true }); }
  catch (error: unknown) {
    console.warn("[office-documents] temp cleanup failed", { errno: errnoCode(error) });
  }
}

/**
 * Owner files for the document service. Paths are home-relative and already
 * syntax-checked by the contract schemas. Protected subtrees (dot
 * directories, `system`, `agents`) are forbidden, denied subtrees answer as
 * missing, and any symlink on the way is refused.
 */
export class OfficeFileStore {
  constructor(private readonly options: OfficeFileStoreOptions) {}

  /** 503 unless the configured home is an existing directory. */
  async assertAvailable(): Promise<void> {
    const info = await lstatOrNull(this.options.homePath);
    if (!info || !info.isDirectory()) throw new OfficeDocumentError("unavailable", "home path missing");
  }

  private async guard(path: string): Promise<void> {
    const { homePath } = this.options;
    const resolved = resolveWithinHome(homePath, path);
    if (!resolved) throw new OfficeDocumentError("invalid_request", "outside home");
    if (isProtectedHomeSubpath(homePath, resolved)) throw new OfficeDocumentError("forbidden", "protected path");
    if (isDeniedFileApiPath(homePath, path)) throw new OfficeDocumentError("not_found", "denied path");
    if (await hasSymlinkComponent(homePath, path)) throw new OfficeDocumentError("forbidden", "symlink");
  }

  async resolveExisting(path: string): Promise<string> {
    await this.guard(path);
    const resolved = callPathHelper(() => resolveExistingFileApiPath(this.options.homePath, path));
    if (!resolved) throw new OfficeDocumentError("not_found");
    return resolved;
  }

  async resolveWritable(path: string): Promise<string> {
    await this.guard(path);
    const resolved = callPathHelper(() => resolveWritableFileApiPath(this.options.homePath, path));
    if (!resolved) throw new OfficeDocumentError("forbidden", "unwritable path");
    return resolved;
  }

  /** Reads a whole regular file of at most `maxFileBytes`, with the version of exactly those bytes. */
  async read(path: string): Promise<LoadedOfficeFile> {
    const absolutePath = await this.resolveExisting(path);
    let handle;
    try {
      handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (errnoCode(error) === "ELOOP") throw new OfficeDocumentError("forbidden", "symlink");
      throw error;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new OfficeDocumentError("invalid_request", "not a regular file");
      if (before.size > BigInt(this.options.maxFileBytes)) throw new OfficeDocumentError("too_large");
      const bytes = new Uint8Array(await handle.readFile());
      const after = await handle.stat({ bigint: true });
      const version = appFileVersion(before.size, before.mtimeNs);
      if (BigInt(bytes.byteLength) !== after.size || appFileVersion(after.size, after.mtimeNs) !== version) {
        throw new OfficeDocumentError("version_conflict", "file changed during read");
      }
      return { path, absolutePath, bytes, version };
    } finally {
      await handle.close();
    }
  }

  /** The current version of a file, or null when it does not exist. */
  async currentVersion(absolutePath: string): Promise<string | null> {
    const info = await lstatOrNull(absolutePath, true);
    if (!info) return null;
    if (!info.isFile()) throw new OfficeDocumentError(info.isSymbolicLink() ? "forbidden" : "invalid_request", "not a regular file");
    return appFileVersion(info.size, info.mtimeNs);
  }

  /**
   * Atomic save with a version check. `expectedVersion` is the version the
   * edit was computed from; `null` means the file must not exist yet. The
   * compare, the temp write and the publish run inside the owner file
   * mutation guard, so a newer save is never overwritten, and inside the
   * project write fence, like every owner file route.
   */
  async commit(path: string, bytes: Uint8Array, expectedVersion: string | null): Promise<CommittedOfficeFile> {
    if (bytes.byteLength > this.options.maxFileBytes) throw new OfficeDocumentError("too_large", "result too large");
    const target = await this.resolveWritable(path);
    if (this.options.beforeCommit) await this.options.beforeCommit(target);
    const guard = this.options.writeGuard ?? unguardedProjectWrite;
    return withOwnerFileMutation(this.options.homePath, () => guard([path], async () => {
      const parent = await this.ensureParent(path, target);
      const current = await lstatOrNull(target, true);
      if (current && !current.isFile()) {
        throw new OfficeDocumentError(current.isSymbolicLink() ? "forbidden" : "invalid_request", "target is not a regular file");
      }
      if (expectedVersion === null) {
        if (current) throw new OfficeDocumentError("file_exists");
      } else if (!current) {
        throw new OfficeDocumentError("version_conflict", "file removed");
      } else if (appFileVersion(current.size, current.mtimeNs) !== expectedVersion) {
        throw new OfficeDocumentError("version_conflict", "version mismatch");
      }

      const temp = join(parent, `${OFFICE_TEMP_PREFIX}${randomUUID()}.tmp`);
      let published = false;
      try {
        const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        try {
          await handle.writeFile(bytes);
          if (current) await handle.chmod(Number(current.mode) & 0o7777);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (expectedVersion === null) {
          try { await link(temp, target); }
          catch (error: unknown) {
            if (errnoCode(error) === "EEXIST") throw new OfficeDocumentError("file_exists", "created concurrently");
            throw error;
          }
        } else {
          await rename(temp, target);
          published = true;
        }
      } finally {
        // After a link the temp name is a second hard link; it always goes.
        if (!published) await removeTemp(temp);
      }

      const written = await lstat(target, { bigint: true });
      return { path, version: appFileVersion(written.size, written.mtimeNs), size: Number(written.size) };
    }));
  }

  private async ensureParent(path: string, target: string): Promise<string> {
    const parent = dirname(target);
    const info = await lstatOrNull(parent);
    if (info) {
      if (!info.isDirectory()) throw new OfficeDocumentError("invalid_request", "parent is not a directory");
      return parent;
    }
    await mkdir(parent, { recursive: true });
    // Another process could have planted a link between the check and mkdir.
    const slash = path.lastIndexOf("/");
    if (slash > 0 && await hasSymlinkComponent(this.options.homePath, path.slice(0, slash))) {
      throw new OfficeDocumentError("forbidden", "symlink");
    }
    return parent;
  }
}
