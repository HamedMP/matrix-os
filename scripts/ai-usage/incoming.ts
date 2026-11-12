import { chmod, copyFile, lstat, mkdir, opendir, rename, rm, utimes } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { USAGE_BACKUP_PATHS } from "../../packages/contracts/src/ai-usage/node";
export const incomingName = /^auto-[a-f0-9-]{36}$/;
function stagePath(root: string, id: string) {
  if (!incomingName.test(id)) throw new Error("Invalid incoming history");
  return join(root, "incoming", id);
}
async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
/** Publishes staged files by content, never by size and time: a rewritten file with the same
 * size and timestamp must still replace the verified original, whose bytes move to `replaced`. */
async function publishTree(
  source: string,
  destination: string,
  replaced: string,
  depth = 0,
): Promise<void> {
  if (depth > 32) throw new Error("Staged history nesting limit");
  const st = await lstat(source);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for await (const entry of await opendir(source))
      await publishTree(
        join(source, entry.name),
        join(destination, entry.name),
        join(replaced, entry.name),
        depth + 1,
      );
    return;
  }
  if (!st.isFile()) return;
  let current;
  try {
    current = await lstat(destination);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current) {
    if (
      current.isFile() &&
      current.size === st.size &&
      (await digest(destination)) === (await digest(source))
    )
      return;
    await mkdir(dirname(replaced), { recursive: true, mode: 0o700 });
    await rename(destination, replaced);
  }
  // Exclusive create: nothing may appear at the destination between the check and the copy.
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  await utimes(destination, st.atime, st.mtime);
}
/** Failed transfers expire after 24h; cap concurrent/stale attempts before accepting another. */
export async function prepareIncoming(
  root: string,
  id: string,
  io = {
    stat: (path: string) => lstat(path),
    remove: (path: string) => rm(path, { recursive: true }),
  },
) {
  const parent = join(root, "incoming");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink())
    throw new Error("Invalid incoming directory");
  let retained = 0,
    visited = 0;
  for await (const entry of await opendir(parent)) {
    if (++visited > 256) throw new Error("Incoming history limit");
    try {
      const path = join(parent, entry.name),
        st = await io.stat(path);
      if (
        !incomingName.test(entry.name) ||
        !st.isDirectory() ||
        st.isSymbolicLink()
      )
        throw new Error("Invalid incoming history");
      if (Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) await io.remove(path);
      else retained++;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  if (retained >= 48) throw new Error("Incoming history limit");
  await mkdir(join(stagePath(root, id), "mac"), {
    recursive: true,
    mode: 0o700,
  });
}
/** Caller holds .refresh.lock across publication, verification and indexing. Transfers never touch canonical originals. */
export async function publishIncoming(root: string, id: string) {
  const incoming = stagePath(root, id);
  const st = await lstat(incoming);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new Error("Invalid incoming history");
  const revision = join(root, "revisions", `auto-${randomUUID()}`, "mac");
  for (const relative of USAGE_BACKUP_PATHS) {
    const source = join(incoming, "mac", relative);
    let sourceStat;
    try {
      sourceStat = await lstat(source);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      sourceStat.isSymbolicLink() ||
      (!sourceStat.isDirectory() && !sourceStat.isFile())
    )
      throw new Error("Invalid staged history");
    const directory = sourceStat.isDirectory(),
      destination = join(root, "mac", relative);
    await mkdir(directory ? destination : dirname(destination), {
      recursive: true,
      mode: 0o700,
    });
    await publishTree(source, destination, join(revision, relative));
  }
  return { finish: () => rm(incoming, { recursive: true }) };
}
