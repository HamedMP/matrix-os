/**
 * Cross-process lock for one profile's `/mcp` tokens (spec 2691). It
 * serializes refreshes (rotating refresh tokens are single-use, so two bridges
 * on one profile must not both spend the same one) with login saves and logout.
 *
 * The lock is published atomically: its full content is written to a unique
 * temp file, then `link()`ed into place, which fails if the lock exists. So a
 * visible lock always has complete content from its creator. A lock is broken
 * only when its PID is gone, it is older than STALE_MS, or it is unreadable
 * AND its mtime is past the same grace period; never immediately.
 *
 * Breaking is serialized by a `<lock>.recover` marker: a bridge removes a stale
 * lock only while it holds the marker and after judging the lock again. Without
 * it, two bridges could both judge one dead lock stale and the slower `unlink`
 * would delete the faster bridge's fresh replacement. A marker whose owner died
 * is cleared after the same grace period.
 */
import { randomBytes } from "node:crypto";
import { link, readFile, stat, unlink, writeFile } from "node:fs/promises";

const STALE_MS = 30_000;
const POLL_MS = 50;
const WAIT_MS = 20_000;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) {
    // EPERM means the PID exists under another user: treat it as alive.
    return errorCode(error) === "EPERM";
  }
}

async function ignoreMissing(operation: Promise<unknown>): Promise<void> {
  try { await operation; }
  catch (error: unknown) { if (errorCode(error) !== "ENOENT") throw error; }
}

async function isStale(path: string, now: number): Promise<boolean> {
  let mtimeMs: number;
  try { mtimeMs = (await stat(path)).mtimeMs; }
  catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false; // released meanwhile; retry the create
    throw error;
  }
  let held: { pid?: unknown; createdAt?: unknown } | null = null;
  try { held = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; createdAt?: unknown }; }
  catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (!held || typeof held.pid !== "number" || typeof held.createdAt !== "number") {
    // Unreadable or partial (for example a foreign or legacy writer): stale only after the grace period.
    return now - mtimeMs > STALE_MS;
  }
  return !processAlive(held.pid) || now - held.createdAt > STALE_MS;
}

/** Returns true when this process held the recovery marker, so the caller may retry at once. */
async function breakStaleLock(path: string): Promise<boolean> {
  const marker = `${path}.recover`;
  try { await writeFile(marker, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    try {
      if (Date.now() - (await stat(marker)).mtimeMs > STALE_MS) await ignoreMissing(unlink(marker));
    } catch (statError: unknown) { if (errorCode(statError) !== "ENOENT") throw statError; }
    return false;
  }
  try {
    // Judge again under the marker: another bridge may have replaced the lock already.
    if (await isStale(path, Date.now())) await ignoreMissing(unlink(path));
  } finally { await ignoreMissing(unlink(marker)); }
  return true;
}

export async function withProfileRefreshLock<T>(path: string, operation: () => Promise<T>,
  options: { waitMs?: number } = {}): Promise<T> {
  const nonce = randomBytes(16).toString("hex");
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  const staging = `${path}.${nonce}.tmp`;
  await writeFile(staging, JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce }), { flag: "wx", mode: 0o600 });
  try {
    for (;;) {
      try {
        await link(staging, path);
        break;
      } catch (error: unknown) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (await isStale(path, Date.now()) && await breakStaleLock(path)) continue;
        if (Date.now() >= deadline) throw new Error("Matrix MCP tokens are busy in another process");
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
      }
    }
  } finally { await ignoreMissing(unlink(staging)); }
  try { return await operation(); }
  finally {
    // Release only our own lock: a stale-broken lock may now belong to another process.
    try {
      const held = JSON.parse(await readFile(path, "utf8")) as { nonce?: unknown };
      if (held.nonce === nonce) await unlink(path);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") console.error("Matrix MCP refresh lock release failed.", error instanceof Error ? error.name : "UnknownError");
    }
  }
}
