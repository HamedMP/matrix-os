import { lstat, mkdir, opendir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { USAGE_BACKUP_PATHS } from "../../packages/contracts/src/ai-usage/node";
const exec = promisify(execFile);
export const incomingName = /^auto-[a-f0-9-]{36}$/;
function stagePath(root: string, id: string) {
  if (!incomingName.test(id)) throw new Error("Invalid incoming history");
  return join(root, "incoming", id);
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
    await exec(
      "rsync",
      [
        "-a",
        "--no-links",
        "--no-devices",
        "--no-specials",
        "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
        "--backup",
        `--backup-dir=${join(revision, directory ? relative : dirname(relative))}`,
        source + (directory ? "/" : ""),
        destination + (directory ? "/" : ""),
      ],
      { timeout: 20 * 60 * 1000, maxBuffer: 1024 * 1024 },
    );
  }
  return { finish: () => rm(incoming, { recursive: true }) };
}
