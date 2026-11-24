/**
 * The Matrix Core install lock (spec 2691, layer 6). One run at a time per
 * install root: the timer and a manual `matrix core sync` must not interleave
 * renames. The lock file records the owner PID and a random token.
 *
 * - Reclaimed only when its owner PID is dead, or when it has not been
 *   renewed for `maxAgeMs` (a hung or unreadable legacy lock).
 * - Removing the lock file, whether reclaiming a stale one or releasing one's
 *   own, needs the removal right for that exact content: a marker file
 *   `<lock>.reclaim-<hash of content>` created with `wx`. Only one run can hold
 *   it, and while it is held nobody else can remove the lock file, and nobody
 *   can create one either (`wx` fails while it exists). So the content check
 *   and the removal cannot interleave with another run, and the lock path is
 *   never moved aside. A marker whose holder died is itself reclaimed the same
 *   way, one level down.
 * - Renewed (mtime) every `heartbeatMs` while the owning run still holds it; a
 *   run that finds its lock replaced stops renewing, and `assertHeld()` fails.
 * - Released only by the run whose token it still holds.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const CORE_REPO_LOCK_MAX_AGE_MS = 60 * 60_000;
export const CORE_REPO_LOCK_HEARTBEAT_MS = 60_000;
/** A removal section lasts milliseconds; a marker this old belongs to a hung or dead run. */
const MARKER_MAX_AGE_MS = 5 * 60_000;
const MAX_MARKER_DEPTH = 3;
const MARKER_INFIX = ".reclaim-";

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

function markerFor(path: string, content: string): string {
  return `${path}${MARKER_INFIX}${createHash("sha256").update(content).digest("hex").slice(0, 32)}`;
}

/** "gone" when the file vanished while being checked. */
async function isStale(path: string, content: string, maxAgeMs: number): Promise<boolean | "gone"> {
  let mtimeMs: number;
  try { mtimeMs = (await stat(path)).mtimeMs; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
  const owner = parseOwner(content);
  return (owner !== null && !isAlive(owner.pid)) || Date.now() - mtimeMs > maxAgeMs;
}

/**
 * Removes `path` only if it still holds `content`, under the removal right for
 * that content. Returns false when another run holds that right.
 */
async function removeIfUnchanged(path: string, content: string, self: string, depth = 0): Promise<boolean> {
  const marker = markerFor(path, content);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(marker, self, { flag: "wx", mode: 0o600 });
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt > 0 || depth >= MAX_MARKER_DEPTH) return false;
    }
    const held = await readText(marker);
    if (held === null) continue;
    const stale = await isStale(marker, held, MARKER_MAX_AGE_MS);
    if (stale === "gone") continue;
    // The marker's holder died or hung mid-section: take the removal right for the marker itself.
    if (!stale || !await removeIfUnchanged(marker, held, self, depth + 1)) return false;
  }
  try {
    if (await readText(path) === content) await rm(path, { force: true });
    return true;
  } finally {
    if (await readText(marker) === self) await rm(marker, { force: true });
  }
}

/** Removes markers left by runs that died mid-section. Only symlink-free regular files are touched. */
async function sweepMarkers(path: string, lockContent: string): Promise<void> {
  const directory = dirname(path);
  const prefix = `${basename(path)}${MARKER_INFIX}`;
  const active = basename(markerFor(path, lockContent));
  const now = Date.now();
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(prefix) || entry === active) continue;
    // A nested marker guards a parent marker; keep it while that parent exists.
    const parent = entry.slice(0, entry.lastIndexOf(MARKER_INFIX));
    if (parent !== basename(path) && await readText(join(directory, parent)) !== null) continue;
    try {
      const info = await lstat(join(directory, entry));
      if (info.isFile() && !info.isSymbolicLink() && now - info.mtimeMs > MARKER_MAX_AGE_MS) await rm(join(directory, entry), { force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export interface CoreRepoLock {
  /** Throws CoreRepoLockedError once another run has taken the lock. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export async function acquireCoreRepoLock(path: string, options: { maxAgeMs?: number; heartbeatMs?: number } = {}): Promise<CoreRepoLock> {
  const token = randomBytes(16).toString("hex");
  const content = JSON.stringify({ pid: process.pid, token });
  const maxAgeMs = options.maxAgeMs ?? CORE_REPO_LOCK_MAX_AGE_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt > 1) throw new CoreRepoLockedError();
    }
    const seen = await readText(path);
    if (seen === null) continue;
    const stale = await isStale(path, seen, maxAgeMs);
    if (stale === "gone") continue;
    if (!stale || !await removeIfUnchanged(path, seen, content)) throw new CoreRepoLockedError();
  }
  try { await sweepMarkers(path, content); }
  catch (error: unknown) {
    console.warn("[core-repo] lock marker sweep failed", error instanceof Error ? error.name : "UnknownError");
  }

  let lost = false;
  const owned = async () => !lost && await readText(path) === content;
  const heartbeat = setInterval(() => {
    void owned().then(async (mine) => {
      if (mine) { const now = new Date(); await utimes(path, now, now); return; }
      lost = true;
      clearInterval(heartbeat);
      console.warn("[core-repo] install lock lost to another run");
    }).catch((error: unknown) => {
      console.warn("[core-repo] lock renewal failed", error instanceof Error ? error.name : "UnknownError");
    });
  }, options.heartbeatMs ?? CORE_REPO_LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  return {
    async assertHeld() {
      if (!await owned()) { lost = true; throw new CoreRepoLockedError(); }
    },
    async release() {
      clearInterval(heartbeat);
      if (await owned()) await removeIfUnchanged(path, content, content);
    },
  };
}
