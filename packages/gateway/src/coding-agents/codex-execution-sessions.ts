import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { lstat, mkdir, unlink, writeFile, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { boundedOperation } from "../bounded-operation.js";

const MAX_SESSIONS = 2048;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const unavailable = () => new Error("Selected Codex account is unavailable");

/** Execution references have a hard cap; stale references drain before eviction. */
export function createCodexExecutionSessions(homePath: string, stopSession?: (id: string) => Promise<void>) {
  const marker = join(homePath, "system/ai-providers/codex-execution-revocation.json");
  const sessions = new Map<string, { userId: string; binding: string | null; expiresAt: number }>();
  const indexPath = join(homePath, "system/ai-providers/codex-execution-sessions.json");
  const IndexSchema = z.array(z.object({ sessionId: z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/),
    userId: z.string().min(1).max(256), binding: z.string().regex(/^[a-f0-9]{64}$/).nullable(), expiresAt: z.number().finite(),
  }).strict()).max(MAX_SESSIONS);
  let loaded = false;
  let blocked = false;
  let queue = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = queue.then(fn, fn);
    queue = task.then(() => undefined, () => undefined);
    return task;
  }
  async function load() {
    if (loaded) return;
    try {
      const metadata = await lstat(indexPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) throw unavailable();
      for (const { sessionId, ...entry } of IndexSchema.parse(JSON.parse(await readFile(indexPath, "utf8")))) sessions.set(sessionId, entry);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw unavailable();
    }
    loaded = true;
  }
  async function persist() {
    await mkdir(dirname(indexPath), { recursive: true });
    const temp = `${indexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify([...sessions].map(([sessionId, value]) => ({ sessionId, ...value }))), { flag: "wx", mode: 0o600 });
      await rename(temp, indexPath);
    } finally { await rm(temp, { force: true }); }
  }
  async function assertOpen() {
    if (blocked) throw unavailable();
    try {
      await lstat(marker);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw unavailable();
    }
    throw unavailable();
  }
  async function prepareRevocationInternal() {
    await load();
    await assertOpen();
    blocked = true;
    // Exclusive creation preserves unknown cleanup across process restart.
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, JSON.stringify({ version: 1, state: "draining" }), { flag: "wx", mode: 0o600 });
    const queue = [...sessions.keys()];
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift()!;
        if (!stopSession) throw unavailable();
        await boundedOperation(() => stopSession(id), 5000);
        sessions.delete(id);
      }
    }));
    if (outcomes.some(result => result.status === "rejected")) throw unavailable();
    await persist();
    return async () => {
      await unlink(marker);
      blocked = false;
    };
  }
  async function evictExpired() {
    const expired = [...sessions].filter(([, value]) => value.expiresAt <= Date.now());
    if (!expired.length) return;
    // Serialized maintenance stops only stale sessions. A global fence here would
    // interrupt unrelated children performing their final execution proof check.
    const pending = expired.map(([id]) => id);
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length) {
          const id = pending.shift()!;
          if (!stopSession) throw unavailable();
          await boundedOperation(() => stopSession(id), 5000);
        }
      }));
      if (outcomes.some(result => result.status === "rejected")) throw unavailable();
      for (const [id] of expired) sessions.delete(id);
      await persist();
    } catch (error: unknown) {
      console.warn("[native-codex] Expired session cleanup unavailable:", error instanceof Error ? error.name : "UnknownError");
      // Preserve every reference on uncertain stop/persistence, including across
      // restart. Only failure escalates routine maintenance to a global fence.
      for (const [id, value] of expired) sessions.set(id, value);
      blocked = true;
      await mkdir(dirname(marker), { recursive: true });
      await writeFile(marker, JSON.stringify({ version: 1, state: "draining" }), { flag: "wx", mode: 0o600 });
      throw unavailable();
    }
  }
  return {
    assertOpen,
    prepareRevocation: () => serialize(prepareRevocationInternal),
    register(userId: string, sessionId: string | undefined, binding: string | null) {
      return serialize(async () => {
        await load();
        await assertOpen();
        await evictExpired();
        // Null tracks an API-key child for cleanup; it is never native subscription proof.
        if (!sessionId) return;
        if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) throw unavailable();
        const prior = sessions.get(sessionId);
        if (prior && (prior.userId !== userId || prior.binding !== binding)) throw unavailable();
        sessions.set(sessionId, { userId, binding, expiresAt: Date.now() + SESSION_TTL_MS });
        await persist();
      });
    },
    releaseCleanFailure(userId: string, sessionId: string, binding?: string | null) {
      return serialize(async () => {
        await load();
        const prior = sessions.get(sessionId);
        if (!prior || prior.userId !== userId || (binding !== undefined && prior.binding !== binding)) return;
        sessions.delete(sessionId);
        try { await persist(); }
        catch (error: unknown) { sessions.set(sessionId, prior); throw error; }
      });
    },
    get(sessionId: string) {
      return serialize(async () => {
        await load();
        await assertOpen();
        await evictExpired();
        return sessions.get(sessionId);
      });
    },
  };
}
