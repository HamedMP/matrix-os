/** One private, bounded recovery location; never sweep owner workspaces. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, rm } from "node:fs/promises";
import { join } from "node:path";

const TTL_MS = 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 256;
const STAGE_NAME = /^(?:clone|index)-[a-f0-9-]{36}$/;
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export function createGithubDeveloperStaging(homePath: string) {
  const root = join(homePath, ".matrix-github-staging");
  const active = new Map<string, { ino: number; dev: number }>(); // <=64; explicit release, TTL after restart.
  let allocations = 0;
  let closed = false;
  let sweeping: Promise<void> | undefined;
  async function ensureRoot() {
    const home = await lstat(homePath);
    if (!home.isDirectory() || home.isSymbolicLink()) throw new Error("Unsafe GitHub staging home");
    try { await mkdir(root, { mode: 0o700 }); }
    catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe GitHub staging root");
  }
  async function sweepEntries() {
    await ensureRoot();
    let count = 0;
    for await (const entry of await opendir(root)) {
      if (++count > MAX_ENTRIES) break;
      const path = join(root, entry.name);
      if (!STAGE_NAME.test(entry.name) || active.has(path)) continue;
      try {
        const info = await lstat(path);
        if (info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && (!process.getuid || info.uid === process.getuid()) && Date.now() - info.mtimeMs >= TTL_MS) await rm(path, { recursive: true, force: true });
      } catch (error: unknown) { if (!missing(error)) throw error; }
    }
  }
  function sweep() {
    if (!sweeping) sweeping = sweepEntries().finally(() => { sweeping = undefined; });
    return sweeping;
  }
  const timer = setInterval(() => { void sweep().catch(error => console.warn("[github] Staging recovery failed", error instanceof Error ? error.name : "UnknownError")); }, INTERVAL_MS);
  timer.unref();
  async function create(kind: "clone" | "index") {
    if (closed || active.size + allocations >= 64) throw new Error("GitHub staging unavailable");
    allocations++;
    try {
      await sweep();
      let count = 0;
      for await (const _entry of await opendir(root)) if (++count >= MAX_ENTRIES - allocations) throw new Error("GitHub staging full");
      const path = join(root, `${kind}-${randomUUID()}`);
      await mkdir(path, { mode: 0o700 });
      const info = await lstat(path);
      active.set(path, { ino: info.ino, dev: info.dev });
      return path;
    } finally { allocations--; }
  }
  async function remove(path: string) {
    const original = active.get(path);
    if (!original) throw new Error("Unknown GitHub staging");
    try {
      await ensureRoot();
      const current = await lstat(path);
      if (!current.isSymbolicLink() && current.isDirectory() && current.ino === original.ino && current.dev === original.dev) await rm(path, { recursive: true, force: true });
    } catch (error: unknown) { if (!missing(error)) throw error; }
    finally { active.delete(path); }
  }
  return { create, remove, sweep, async close() { closed = true; clearInterval(timer); await sweeping; } };
}
