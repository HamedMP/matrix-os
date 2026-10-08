// Disposable personal navigation metadata. Authority always comes from main's
// current AuthService, never a renderer-supplied owner or filesystem path.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { CanonicalChatNavigationResponseSchema, type CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import type { AuthStatus } from "../auth/auth-service";
import type { NavigationCacheFence } from "../../shared/navigation-cache-ipc";
export const NAVIGATION_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_BYTES + 4096;
const MAX_SCOPES = 3;
const MAX_QUEUED_OPERATIONS = 32;
const HASH_FILE = /^[a-f0-9]{64}\.json$/;
const TEMP_FILE = /^[a-f0-9]{64}\.[a-f0-9]{12}\.tmp$/;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Envelope = z.strictObject({
  version: z.literal(1),
  scope: Hash,
  owner: Hash,
  storedAt: z.number().int().nonnegative(),
  touchedAt: z.number().int().nonnegative(),
  snapshot: CanonicalChatNavigationResponseSchema,
});
type Saved = z.infer<typeof Envelope>;
interface Options {
  dir: string;
  getStatus: () => AuthStatus;
  clock?: () => number;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function identity(status: AuthStatus) {
  return status.signedIn ? {
    scope: hash(JSON.stringify([1, status.userId, status.platformHost, status.handle, status.runtimeSlot, "personal"])),
    owner: hash(JSON.stringify([1, status.userId, status.platformHost])),
    authGeneration: status.authGeneration,
  } : null;
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
export interface NavigationCacheContext {
  scope: string | null;
  authGeneration: number;
}
export interface NavigationCache {
  observe(status: AuthStatus): void;
  context(): NavigationCacheContext;
  load(fence: NavigationCacheFence): Promise<{
    snapshot: CanonicalChatNavigationResponse | null;
  }>;
  save(input: NavigationCacheFence & {
    snapshot: CanonicalChatNavigationResponse;
  }): Promise<{
    ok: boolean;
  }>;
  clear(fence: NavigationCacheFence): Promise<{
    ok: boolean;
  }>;
  drain(): Promise<void>;
}
export function createNavigationCache(options: Options): NavigationCache {
  const dir = join(options.dir, "navigation-cache");
  const clock = options.clock ?? Date.now;
  let current = identity(options.getStatus());
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let cleanupQueued = false;
  function serial<T>(fn: () => Promise<T>, cleanup = false): Promise<T> {
    // One reserved coalesced account cleanup cannot be starved by IPC traffic.
    if (!cleanup && queued >= MAX_QUEUED_OPERATIONS) {
      return Promise.reject(new Error("cache queue full"));
    }
    queued++;
    const result = tail.then(fn, fn).finally(() => { queued--; });
    tail = result.then(() => undefined, error => {
      console.warn("[navigation-cache] storage operation failed", error instanceof Error ? error.name : "UnknownError");
    });
    return result;
  }
  async function directory() {
    await mkdir(dir, {
      recursive: true, mode: 0o700
    });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("invalid cache directory");
  }
  async function remove(path: string) {
    try {
      const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink())
        await unlink(path);
    }
    catch (error: unknown) {
      if (!missing(error))
        throw error;
    }
  }
  async function read(path: string): Promise<Saved | null> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        return null;
      // A fixed-size read remains bounded even if a file grows after stat.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead)
          break;
        length += result.bytesRead;
      }
      if (length > MAX_FILE_BYTES)
        return null;
      const parsed = Envelope.safeParse(JSON.parse(buffer.toString("utf8", 0, length)));
      if (!parsed.success)
        return null;
      const value = parsed.data;
      const invalid = value.scope + ".json" !== path.split(/[\\/]/).at(-1)
        || clock() - value.storedAt > NAVIGATION_CACHE_MAX_AGE
        || value.storedAt > clock()
        || Buffer.byteLength(JSON.stringify(value.snapshot)) > MAX_BYTES
        || value.snapshot.truncated
        || value.snapshot.items.some(item => item.persistence !== "personal");
      if (invalid) return null;
      return value;
    }
    catch (error: unknown) {
      if (!missing(error))
        console.warn("[navigation-cache] ignored unreadable snapshot", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
    finally {
      await file?.close();
    }
  }
  async function sweep(removeAll = false): Promise<Saved[]> {
    await directory();
    const retained: Saved[] = [];
    // Limit both directory enumeration and retained metadata, including foreign
    // files. This private store creates at most three scopes plus one temp.
    let examined = 0;
    const entries = await opendir(dir);
    for await (const entry of entries) {
      if (++examined > 64)
        break;
      if (entry.isSymbolicLink() || !entry.isFile())
        continue;
      const path = join(dir, entry.name);
      if (TEMP_FILE.test(entry.name)) {
        await remove(path);
        continue;
      }
      if (!HASH_FILE.test(entry.name))
        continue;
      const value = await read(path);
      if (!value || removeAll) {
        await remove(path);
        continue;
      }
      retained.push(value);
      retained.sort((a, b) => b.touchedAt - a.touchedAt);
      if (retained.length > MAX_SCOPES) {
        const evicted = retained.pop()!;
        await remove(join(dir, evicted.scope + ".json"));
      }
    }
    retained.sort((a, b) => b.touchedAt - a.touchedAt);
    for (const value of retained.slice(MAX_SCOPES))
      await remove(join(dir, value.scope + ".json"));
    return retained.slice(0, MAX_SCOPES);
  }
  async function write(value: Saved, valid: () => boolean): Promise<boolean> {
    await directory();
    const path = join(dir, value.scope + ".json");
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink())
        return false;
    }
    catch (error: unknown) {
      if (!missing(error))
        throw error;
    }
    const tmp = join(dir, value.scope + "." + randomBytes(6).toString("hex") + ".tmp");
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(JSON.stringify(value), "utf8");
      await file.close();
      file = undefined;
      if (!valid())
        return false;
      await rename(tmp, path);
      return true;
    }
    finally {
      await file?.close();
      await remove(tmp);
    }
  }
  function queueAccountCleanup() {
    if (cleanupQueued) return;
    cleanupQueued = true;
    // Disposable partitions can all be removed on account replacement. The
    // coalesced cleanup precedes new writes and avoids an unbounded owner set.
    void serial(async () => {
      try { await sweep(true); }
      finally { cleanupQueued = false; }
    }, true).catch(error => {
      console.warn("[navigation-cache] account cleanup failed", error instanceof Error ? error.name : "UnknownError");
    });
  }
  function observe(status: AuthStatus) {
    const next = identity(status);
    if (current?.scope === next?.scope && current?.authGeneration === next?.authGeneration)
      return;
    const previous = current;
    current = next;
    epoch++;
    if (previous && (!next || previous.owner !== next.owner)) queueAccountCleanup();
  }

  // Construction follows AuthService.init(). Revocation detected during that
  // startup has no preceding in-process identity for observe() to compare.
  if (!current) queueAccountCleanup();

  function context(): NavigationCacheContext {
    const status = options.getStatus();
    observe(status);
    return {
      scope: current?.scope ?? null, authGeneration: status.authGeneration
    };
  }
  function accepted(fence: NavigationCacheFence, captured: number): boolean {
    const status = options.getStatus();
    observe(status);
    return captured === epoch && current?.scope === fence.scope && current.authGeneration === fence.authGeneration;
  }
  return {
    observe, context,
    async load(fence: NavigationCacheFence): Promise<{
      snapshot: CanonicalChatNavigationResponse | null;
    }> {
      context();
      const captured = epoch;
      if (!accepted(fence, captured))
        return {
          snapshot: null
        };
      try {
        return await serial(async () => {
          if (!accepted(fence, captured))
            return {
              snapshot: null
            };
          await directory();
          const value = await read(join(dir, fence.scope + ".json"));
          if (!value || !accepted(fence, captured)) {
            // Cleanup stays off the cache-to-paint path even for invalid files.
            void serial(() => sweep()).catch(error => {
              console.warn("[navigation-cache] prune unavailable", error instanceof Error ? error.name : "UnknownError");
            });
            return { snapshot: null };
          }
          void serial(async () => {
            if (!accepted(fence, captured)) return;
            await sweep();
            // Re-read: a queued newer save must not be replaced by this load's
            // older value merely to update its LRU timestamp.
            const latest = await read(join(dir, fence.scope + ".json"));
            if (latest && accepted(fence, captured)) {
              await write({ ...latest, touchedAt: clock() }, () => accepted(fence, captured));
            }
          }).catch(error => {
            console.warn("[navigation-cache] touch unavailable", error instanceof Error ? error.name : "UnknownError");
          });
          return {
            snapshot: accepted(fence, captured) ? value.snapshot : null
          };
        });
      }
      catch (error: unknown) {
        console.warn("[navigation-cache] load unavailable", error instanceof Error ? error.name : "UnknownError");
        return {
          snapshot: null
        };
      }
    },
    async save(input: NavigationCacheFence & {
      snapshot: CanonicalChatNavigationResponse;
    }): Promise<{
      ok: boolean;
    }> {
      context();
      const captured = epoch;
      const parsed = CanonicalChatNavigationResponseSchema.safeParse(input.snapshot);
      if (!accepted(input, captured) || !parsed.success) return { ok: false };
      if (parsed.data.truncated || Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_BYTES
        || parsed.data.items.some(item => item.persistence !== "personal")) {
        return { ok: false };
      }
      const owner = current!.owner;
      try {
        return await serial(async () => {
          if (!accepted(input, captured))
            return {
              ok: false
            };
          const retained = await sweep();
          const ok = await write({
            version: 1, scope: input.scope, owner,
            storedAt: clock(), touchedAt: clock(), snapshot: parsed.data,
          }, () => accepted(input, captured));
          if (ok) {
            const others = retained.filter(value => value.scope !== input.scope);
            for (const value of others.slice(MAX_SCOPES - 1)) {
              await remove(join(dir, value.scope + ".json"));
            }
          }
          return {
            ok: ok && accepted(input, captured)
          };
        });
      }
      catch (error: unknown) {
        console.warn("[navigation-cache] save unavailable", error instanceof Error ? error.name : "UnknownError");
        return {
          ok: false
        };
      }
    },
    async clear(fence: NavigationCacheFence): Promise<{
      ok: boolean;
    }> {
      context();
      const captured = epoch;
      if (!accepted(fence, captured))
        return {
          ok: false
        };
      // Fence already queued writes before adding the deletion to their chain.
      epoch++;
      try {
        await serial(async () => {
          await directory();
          await remove(join(dir, fence.scope + ".json"));
        });
        return {
          ok: true
        };
      }
      catch (error: unknown) {
        console.warn("[navigation-cache] clear unavailable", error instanceof Error ? error.name : "UnknownError");
        return {
          ok: false
        };
      }
    },
    async drain() {
      // Loads may append their maintenance while the captured tail is running.
      let observed: Promise<unknown>;
      do { observed = tail; await observed; } while (observed !== tail);
    },
  };
}
