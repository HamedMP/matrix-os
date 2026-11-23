import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APP_FILE_MAX_BYTES, appFileVersion,
  type AppFileMkdirReply, type AppFileWriteReply,
} from "@matrix-os/contracts/app-files";
import { withOwnerFileMutation } from "../owner-file-mutations.js";
import { AppFileError, errnoCode } from "./errors.js";
import { appFileIo } from "./io.js";
import { hasSymlinkComponent, lstatOrNull, resolveWritableAppFilePath } from "./paths.js";
import { unguardedProjectWrite, type ProjectWriteGuard } from "./project-write-fence.js";
import { modifiedAtFromMs } from "./read-ops.js";

/** Prefix of the temporary file a write publishes from, in the target's directory. */
export const APP_FILE_TEMP_PREFIX = ".matrix-app-file-";

export interface AppFileWriteRequest {
  path: string;
  contentBase64: string;
  ifVersion: string | null;
  createParents?: boolean;
}

function parentRelativePath(path: string): string | null {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? null : path.slice(0, slash);
}

async function ensureParent(homePath: string, path: string, target: string, createParents: boolean): Promise<string> {
  const parent = dirname(target);
  const info = await lstatOrNull(parent);
  if (info) {
    if (!info.isDirectory()) throw new AppFileError("invalid_request", "parent is not a directory");
    return parent;
  }
  if (!createParents) throw new AppFileError("not_found", "missing parent");
  await mkdir(parent, { recursive: true });
  const parentPath = parentRelativePath(path);
  // Another process could have planted a link between the check and mkdir.
  if (parentPath && await hasSymlinkComponent(homePath, parentPath)) throw new AppFileError("forbidden", "symlink");
  return parent;
}

async function removeTemp(path: string): Promise<void> {
  try { await rm(path, { force: true }); }
  catch (error: unknown) {
    console.warn("[app-files] temp cleanup failed", { errno: errnoCode(error) });
  }
}

/**
 * Atomic write with a version check. The compare, the temp write and the
 * publish run inside the owner file mutation guard, so two writers holding the
 * same version cannot both succeed. `ifVersion: null` publishes with an
 * exclusive `link`, so a file created by anyone in the meantime is a conflict.
 * `guard` is the collaboration project fence; it is held inside the mutation
 * guard from before path resolution until the write settles.
 */
export async function writeAppFile(
  homePath: string,
  request: AppFileWriteRequest,
  guard: ProjectWriteGuard = unguardedProjectWrite,
): Promise<AppFileWriteReply> {
  const content = Buffer.from(request.contentBase64, "base64");
  if (content.length > APP_FILE_MAX_BYTES) throw new AppFileError("too_large");
  return withOwnerFileMutation(homePath, () => guard([request.path], async () => {
    const target = await resolveWritableAppFilePath(homePath, request.path);
    const parent = await ensureParent(homePath, request.path, target, request.createParents === true);
    const current = await lstatOrNull(target, true);
    if (current && !current.isFile()) {
      throw new AppFileError(current.isSymbolicLink() ? "forbidden" : "invalid_request", "target is not a regular file");
    }
    if (request.ifVersion === null) {
      if (current) throw new AppFileError("version_conflict", "file exists");
    } else if (!current || appFileVersion(current.size, current.mtimeNs) !== request.ifVersion) {
      throw new AppFileError("version_conflict", "version mismatch");
    }

    const temp = join(parent, `${APP_FILE_TEMP_PREFIX}${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
      try {
        await handle.writeFile(content);
        if (current) await handle.chmod(Number(current.mode) & 0o7777);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (request.ifVersion === null) {
        try { await appFileIo.link(temp, target); }
        catch (error: unknown) {
          if (errnoCode(error) === "EEXIST") throw new AppFileError("version_conflict", "file created concurrently");
          throw error;
        }
      } else {
        await appFileIo.rename(temp, target);
        renamed = true;
      }
    } finally {
      // After a link the temp name is a second hard link; it always goes.
      if (!renamed) await removeTemp(temp);
    }

    const written = await lstatOrNull(target, true);
    if (!written || !written.isFile()) throw new AppFileError("unavailable", "written file missing");
    return {
      path: request.path,
      version: appFileVersion(written.size, written.mtimeNs),
      size: Number(written.size),
      modifiedAt: modifiedAtFromMs(written.mtimeMs),
    };
  }));
}

/** Recursive and idempotent; an existing directory is success. */
export async function mkdirAppFile(
  homePath: string,
  path: string,
  guard: ProjectWriteGuard = unguardedProjectWrite,
): Promise<AppFileMkdirReply> {
  return withOwnerFileMutation(homePath, () => guard([path], async () => {
    const target = await resolveWritableAppFilePath(homePath, path);
    const existing = await lstatOrNull(target);
    if (existing) {
      if (existing.isDirectory()) return { path };
      throw new AppFileError(existing.isSymbolicLink() ? "forbidden" : "invalid_request", "target is not a directory");
    }
    await mkdir(target, { recursive: true });
    if (await hasSymlinkComponent(homePath, path)) throw new AppFileError("forbidden", "symlink");
    return { path };
  }));
}
