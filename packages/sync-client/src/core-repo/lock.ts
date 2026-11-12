/**
 * The Matrix Core install lock (spec 2691, layer 6). One run at a time per
 * install root: the timer and a manual `matrix core sync` must not interleave
 * renames. The lock file records the owner PID and a random token.
 *
 * - Reclaimed only when its owner PID is dead, or when it has not been
 *   renewed for `maxAgeMs` (a hung or unreadable legacy lock).
 * - Renewed (mtime) every `heartbeatMs` while the owning run is alive.
 * - Released only by the run whose token it still holds.
 */
import { randomBytes } from "node:crypto";
import { link, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";

export const CORE_REPO_LOCK_MAX_AGE_MS = 60 * 60_000;
export const CORE_REPO_LOCK_HEARTBEAT_MS = 60_000;

export class CoreRepoLockedError extends Error {
  constructor() { super("locked"); this.name = "CoreRepoLockedError"; }
}

interface LockOwner { pid: number; token: string }

function parseOwner(text: string): LockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    return Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.token === "string" ? value as LockOwner : null;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Moves a stale lock aside; if a newer lock was moved by mistake, it is restored and the caller stays locked out. */
async function reclaim(path: string, seen: string, token: string): Promise<void> {
  const aside = `${path}.stale-${token}`;
  try { await rename(path, aside); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (await readText(aside) === seen) {
    await rm(aside, { force: true });
    return;
  }
  try { await link(aside, path); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(aside, { force: true });
  }
  throw new CoreRepoLockedError();
}

export async function acquireCoreRepoLock(path: string, options: { maxAgeMs?: number; heartbeatMs?: number } = {}): Promise<{ release(): Promise<void> }> {
  const token = randomBytes(16).toString("hex");
  const content = JSON.stringify({ pid: process.pid, token });
  const maxAgeMs = options.maxAgeMs ?? CORE_REPO_LOCK_MAX_AGE_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CoreRepoLockedError();
        throw error;
      }
    }
    const seen = await readText(path);
    if (seen === null) continue;
    const owner = parseOwner(seen);
    let mtimeMs: number;
    try { mtimeMs = (await stat(path)).mtimeMs; }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const ownerDead = owner !== null && !isAlive(owner.pid);
    if (!ownerDead && Date.now() - mtimeMs <= maxAgeMs) throw new CoreRepoLockedError();
    await reclaim(path, seen, token);
  }

  const owned = async () => await readText(path) === content;
  const heartbeat = setInterval(() => {
    void owned().then(async (mine) => {
      if (mine) { const now = new Date(); await utimes(path, now, now); }
    }).catch((error: unknown) => {
      console.warn("[core-repo] lock renewal failed", error instanceof Error ? error.name : "UnknownError");
    });
  }, options.heartbeatMs ?? CORE_REPO_LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  return {
    async release() {
      clearInterval(heartbeat);
      if (await owned()) await rm(path, { force: true });
    },
  };
}
