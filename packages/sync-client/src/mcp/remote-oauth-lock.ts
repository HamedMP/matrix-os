/**
 * Cross-process refresh lock for one profile's `/mcp` tokens (spec 2691).
 * Rotating refresh tokens are single-use, so two bridges on one profile must
 * not both spend the same one. Exclusive create (`wx`) owns the lock; a lock
 * whose PID is gone or that is older than STALE_MS is broken and retaken.
 */
import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";

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

async function isStale(path: string, now: number): Promise<boolean> {
  try {
    const held = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; createdAt?: unknown };
    return typeof held.pid !== "number" || typeof held.createdAt !== "number"
      || !processAlive(held.pid) || now - held.createdAt > STALE_MS;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false; // released meanwhile; retry the create
    if (error instanceof SyntaxError) return true; // a torn write from a crashed holder
    throw error;
  }
}

export async function withProfileRefreshLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const nonce = randomBytes(16).toString("hex");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce }), { flag: "wx", mode: 0o600 });
      break;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await isStale(path, Date.now())) {
        await unlink(path).catch((unlinkError: unknown) => {
          if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
        });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Matrix MCP token refresh is busy in another process");
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
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
