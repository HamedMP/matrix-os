import { constants } from "node:fs";
import {
  lstat,
  opendir,
  open,
  mkdir,
  link,
  unlink,
  rmdir,
} from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
async function* files(path: string, depth = 0): AsyncGenerator<string> {
  if (depth > 32) throw new Error("Backup nesting limit");
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error("Backup symlink");
  if (st.isFile()) {
    yield path;
    return;
  }
  if (!st.isDirectory()) throw new Error("Unsupported backup entry");
  for await (const entry of await opendir(path))
    yield* files(join(path, entry.name), depth + 1);
}
async function prefixEqual(previous: string, current: string) {
  let oldHandle, newHandle;
  try {
    oldHandle = await open(previous, constants.O_RDONLY | constants.O_NOFOLLOW);
    newHandle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = (await oldHandle.stat()).size;
    if (size > (await newHandle.stat()).size) return false;
    const a = Buffer.alloc(65536),
      b = Buffer.alloc(65536);
    for (let offset = 0; offset < size; ) {
      const length = Math.min(a.length, size - offset);
      const x = await oldHandle.read(a, 0, length, offset),
        y = await newHandle.read(b, 0, length, offset);
      if (
        x.bytesRead !== length ||
        y.bytesRead !== length ||
        !a.subarray(0, length).equals(b.subarray(0, length))
      )
        return false;
      offset += length;
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  } finally {
    await oldHandle?.close();
    await newHandle?.close();
  }
}
async function removeEmpty(path: string): Promise<void> {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  for await (const entry of await opendir(path))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await removeEmpty(join(path, entry.name));
  try {
    await rmdir(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOTEMPTY") throw error;
  }
}
/** Only redundant copies made by this updater are removed; replacements become permanent recoverable originals. */
export async function prepareBackupVersions(root: string) {
  const redundant: string[] = [],
    archives: string[] = [],
    runs: string[] = []; // One bounded sync pass, released after finish; no long-lived registry.
  const directory = join(root, "revisions");
  try {
    for await (const entry of await opendir(directory)) {
      if (!entry.name.startsWith("auto-")) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Invalid backup revision");
      const run = join(directory, entry.name);
      runs.push(run);
      if (runs.length > 100000) throw new Error("Backup revision limit");
      for await (const path of files(run)) {
        if (redundant.length + archives.length >= 100000)
          throw new Error("Backup revision file limit");
        const rel = relative(run, path),
          current = join(root, rel);
        if (await prefixEqual(path, current)) {
          redundant.push(path);
          continue;
        }
        const target = join(
          root,
          "recovered",
          dirname(rel),
          `${randomUUID()}-${basename(rel)}`,
        );
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await link(path, target); // Exclusive creation: a retained archive is never overwritten.
        await unlink(path);
        archives.push(target);
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return {
    archives,
    async finish() {
      for (const path of redundant) await unlink(path);
      for (const run of runs) await removeEmpty(run);
    },
  };
}
