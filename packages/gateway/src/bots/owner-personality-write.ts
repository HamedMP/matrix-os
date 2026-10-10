import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { writeUtf8FileAtomic } from "../shell/atomic-write.js";
import { OwnerPersonalityError } from "./owner-personality.js";

function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Canonical Settings producer only. Never truncate a published SOUL inode. */
export async function writeOwnerSoulAtomic(homePath: string, text: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    const home = await realpath(homePath);
    const system = join(home, "system");
    try { await mkdir(system, { mode: 0o700 }); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const parent = await lstat(system);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new OwnerPersonalityError("unsafe_file");
    directory = await open(system, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!sameFile(parent, await directory.stat()) || await realpath(system) !== system) {
      throw new OwnerPersonalityError("unsafe_file");
    }
    // Linux pins every temp/create/commit/cleanup operation to this directory.
    // Other hosts also revalidate its identity immediately before rename.
    const parentPath = process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : system;
    const path = join(parentPath, "soul.md");
    const assertParent = async () => {
      if (!sameFile(parent, await lstat(system)) || await realpath(system) !== system) {
        throw new OwnerPersonalityError("unsafe_file");
      }
    };
    await assertParent();
    await writeUtf8FileAtomic(path, text, 0o600, {
      beforeCommit: async (_temp, stagedFile) => {
        await assertParent();
        let target: Stats | undefined;
        try { target = await lstat(path); }
        catch (error: unknown) { if (!isMissing(error)) throw error; }
        if (target) {
          if (!target.isFile() || target.isSymbolicLink()) throw new OwnerPersonalityError("unsafe_file");
          // Preserve the existing file's write permission boundary without O_TRUNC.
          const existing = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const checked = await existing.stat();
            if (!checked.isFile() || !sameFile(target, checked)) throw new OwnerPersonalityError("unsafe_file");
          } finally { await existing.close(); }
          const staged = await stagedFile.stat();
          if (staged.uid !== target.uid || staged.gid !== target.gid) await stagedFile.chown(target.uid, target.gid);
          await stagedFile.chmod(target.mode & 0o777);
        }
        await assertParent();
      },
      // On non-Linux a renamed parent must not redirect cleanup to another
      // directory. Leave its private staged file for the directory owner rather
      // than unlink a foreign path. Linux cleanup uses the pinned descriptor.
      beforeCleanup: process.platform === "linux" ? undefined : assertParent,
    });
  } catch (error: unknown) {
    if (error instanceof OwnerPersonalityError) throw error;
    throw new OwnerPersonalityError("unreadable");
  } finally { await directory?.close(); }
}
