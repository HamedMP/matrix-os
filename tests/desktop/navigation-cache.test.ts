import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNavigationCache } from "../../desktop/src/main/persistence/navigation-cache";
import { registerNavigationCacheIpc } from "../../desktop/src/main/ipc/navigation-cache";
import type { AuthStatus } from "../../desktop/src/main/auth/auth-service";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual, rename: vi.fn(actual.rename)
  };
});
const snapshot = {
  version: 1 as const, items: [], truncated: false
};
const signedIn = (slot = "primary", userId = "user_a", authGeneration = 1): AuthStatus => ({
  signedIn: true, userId, handle: "review", platformHost: "https://example.test", runtimeSlot: slot, authGeneration
});
let dir: string;
const caches: ReturnType<typeof createNavigationCache>[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "matrix-navigation-"));
  vi.spyOn(console, "warn").mockImplementation(() => {
  });
});
afterEach(async () => {
  // Flush normal cache maintenance before deleting its temporary directory.
  await Promise.all(caches.map(cache => cache.drain()));
  caches.length = 0;
  await rm(dir, {
    recursive: true, force: true
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  let auth = signedIn();
  let now = 1000;
  const cache = createNavigationCache({
    dir, getStatus: () => auth, clock: () => now
  });
  caches.push(cache);
  return {
    cache, context: () => cache.context(), change: (status: AuthStatus) => {
      auth = status;
      cache.observe(status);
    }, clock: (value: number) => {
      now = value;
    }
  };
}
function request(x: ReturnType<typeof fixture>) {
  const ctx = x.context();
  return {
    scope: ctx.scope!, authGeneration: ctx.authGeneration
  };
}
describe("private reconstructable navigation snapshots", () => {
  it("restores nonempty personal metadata without provider or transcript payloads and writes private permissions", async () => {
    const x = fixture();
    const req = request(x);
    const item = {
      chat: {
        id: "chat_cache", title: "Cached title", lifecycle: "active" as const, attention: "none" as const, revision: 1, messageCount: 4, userState: {
          readThroughSeq: 4, pinned: true, muted: false
        }, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z"
      }, readState: {
        unread: false, markedUnread: false, version: 1, readThroughSeq: 4, latestIncomingSeq: 4
      }, classification: {
        kind: "ordinary" as const
      }, persistence: "personal" as const
    };
    const data = {
      ...snapshot, items: [item]
    };
    expect(await x.cache.save({
      ...req, snapshot: data
    })).toEqual({
      ok: true
    });
    expect(await x.cache.load(req)).toEqual({
      snapshot: data
    });
    expect((await stat(join(dir, "navigation-cache", req.scope + ".json"))).mode & 0o777).toBe(0o600);
    expect(await x.cache.save({
      ...req, snapshot: {
        ...data, items: [{
            ...item, persistence: "membership"
          }]
      }
    })).toEqual({
      ok: false
    });
    expect(await x.cache.save({
      ...req, snapshot: {
        ...data, items: Array.from({
          length: 1001
        }, () => item)
      }
    })).toEqual({
      ok: false
    });
    expect(await x.cache.load(req)).toEqual({
      snapshot: data
    });
  });
  it("prunes incompatible owned files and abandoned temp writes on recurring reads", async () => {
    const x = fixture();
    const req = request(x);
    await x.cache.save({
      ...req, snapshot
    });
    const path = join(dir, "navigation-cache", req.scope + ".json");
    const data = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({
      ...data, version: 0
    }));
    const abandoned = join(dir, "navigation-cache", req.scope + ".abcdef123456.tmp");
    await writeFile(abandoned, "partial");
    expect(await x.cache.load(req)).toEqual({
      snapshot: null
    });
    await x.cache.drain();
    await expect(stat(abandoned)).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(stat(path)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
  it("retains a valid snapshot when updating its LRU timestamp fails", async () => {
    const x = fixture();
    const req = request(x);
    await x.cache.save({
      ...req, snapshot
    });
    vi.mocked(files.rename).mockRejectedValueOnce(Object.assign(new Error("storage denied"), {
      code: "EACCES"
    }));
    expect(await x.cache.load(req)).toEqual({
      snapshot
    });
    await x.cache.drain();
    expect(console.warn).toHaveBeenCalledWith("[navigation-cache] touch unavailable", "Error");
  });
  it("returns cached rows before a delayed LRU disk write finishes", async () => {
    const x = fixture();
    const req = request(x);
    await x.cache.save({ ...req, snapshot });
    const originalRename = vi.mocked(files.rename).getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const touched = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(files.rename).mockImplementationOnce(async (...args) => {
      started();
      await gate;
      await originalRename(...args);
    });
    const loaded = x.cache.load(req);
    try {
      await touched;
      expect(await Promise.race([loaded, Promise.resolve("pending")])).toEqual({ snapshot });
    } finally {
      release();
      await x.cache.drain();
    }
  });
  it("caps queued writes without allowing a full queue to starve logout cleanup", async () => {
    const x = fixture();
    const req = request(x);
    const pending = Array.from({ length: 60 }, () => x.cache.save({ ...req, snapshot }));
    const outcomes = await Promise.all(pending);
    expect(outcomes.filter(result => result.ok)).toHaveLength(32);
    const queued = Array.from({ length: 60 }, () => x.cache.save({ ...req, snapshot }));
    x.change({ signedIn: false, runtimeSlot: "primary", platformHost: "https://example.test", authGeneration: 2 });
    expect((await Promise.all(queued)).every(result => !result.ok)).toBe(true);
    await x.cache.drain();
    x.change(signedIn("primary", "user_a", 3));
    expect(await x.cache.load(request(x))).toEqual({ snapshot: null });
  });
  it("persists after restart and separates runtime/account from session generation", async () => {
    const x = fixture();
    const a = request(x);
    await x.cache.save({
      ...a, snapshot
    });
    const restarted = createNavigationCache({
      dir, getStatus: () => signedIn("primary", "user_a", 9), clock: () => 1100
    });
    caches.push(restarted);
    const b = restarted.context();
    expect(b.scope).toBe(a.scope);
    expect(await restarted.load({
      scope: b.scope!, authGeneration: 9
    })).toEqual({
      snapshot
    });
    x.change(signedIn("preview"));
    expect(await x.cache.load(request(x))).toEqual({
      snapshot: null
    });
    x.change(signedIn("primary", "user_b"));
    expect(await x.cache.load(request(x))).toEqual({
      snapshot: null
    });
  });
  it("fences stale requests and queued writes on logout before a new login", async () => {
    const x = fixture();
    const old = request(x);
    const queued = x.cache.save({
      ...old, snapshot
    });
    x.change({
      signedIn: false, runtimeSlot: "primary", platformHost: "https://example.test", authGeneration: 2
    });
    await queued;
    expect(x.context().scope).toBeNull();
    x.change(signedIn("primary", "user_a", 3));
    expect(await x.cache.load(request(x))).toEqual({
      snapshot: null
    });
    expect(await x.cache.save({
      ...old, snapshot
    })).toEqual({
      ok: false
    });
  });
  it("purges all saved runtime partitions for the signed-out account", async () => {
    const x = fixture();
    await x.cache.save({ ...request(x), snapshot });
    x.change(signedIn("preview"));
    await x.cache.save({ ...request(x), snapshot });
    x.change({ signedIn: false, runtimeSlot: "preview", platformHost: "https://example.test", authGeneration: 2 });
    await x.cache.drain();
    const reopened = createNavigationCache({ dir, getStatus: () => signedIn(), clock: () => 1200 });
    caches.push(reopened);
    const ctx = reopened.context();
    expect(await reopened.load({ scope: ctx.scope!, authGeneration: ctx.authGeneration })).toEqual({ snapshot: null });
    x.change(signedIn("preview", "user_a", 3));
    expect(await x.cache.load(request(x))).toEqual({ snapshot: null });
  });
  it("purges retained snapshots when startup authentication is already revoked", async () => {
    const x = fixture();
    await x.cache.save({ ...request(x), snapshot });
    await x.cache.drain();
    let auth: AuthStatus = { signedIn: false, runtimeSlot: "primary", platformHost: "https://example.test", authGeneration: 2 };
    const restarted = createNavigationCache({ dir, getStatus: () => auth, clock: () => 1200 });
    caches.push(restarted);
    await restarted.drain();
    auth = signedIn("primary", "user_a", 3);
    restarted.observe(auth);
    const context = restarted.context();
    expect(await restarted.load({ scope: context.scope!, authGeneration: context.authGeneration })).toEqual({ snapshot: null });
  });
  it("expires snapshots at 24 hours and keeps at most three LRU runtime scopes", async () => {
    const x = fixture();
    for (const slot of ["one", "two", "three", "four"]) {
      x.change(signedIn(slot));
      await x.cache.save({
        ...request(x), snapshot
      });
      x.clock(x.context().authGeneration + 3000 + ["one", "two", "three", "four"].indexOf(slot) * 100);
    }
    x.change(signedIn("one"));
    expect(await x.cache.load(request(x))).toEqual({
      snapshot: null
    });
    x.change(signedIn("four"));
    expect((await x.cache.load(request(x))).snapshot).toEqual(snapshot);
    x.clock(1000 + 24 * 60 * 60 * 1000 + 10000);
    expect(await x.cache.load(request(x))).toEqual({
      snapshot: null
    });
  });
  it("ignores corrupt, incompatible, oversize and symlink snapshots without touching symlink targets", async () => {
    const x = fixture();
    const req = request(x);
    await x.cache.save({
      ...req, snapshot
    });
    const path = join(dir, "navigation-cache", `${req.scope}.json`);
    await writeFile(path, "broken");
    expect(await x.cache.load(req)).toEqual({
      snapshot: null
    });
    await x.cache.save({
      ...req, snapshot
    });
    await writeFile(path, "x".repeat(2 * 1024 * 1024 + 8192));
    expect(await x.cache.load(req)).toEqual({
      snapshot: null
    });
    await x.cache.save({
      ...req, snapshot
    });
    await rm(path);
    const target = join(dir, "private.txt");
    await writeFile(target, "untouched");
    await symlink(target, path);
    expect(await x.cache.load(req)).toEqual({
      snapshot: null
    });
    expect(await x.cache.save({
      ...req, snapshot
    })).toEqual({
      ok: false
    });
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
  it("clears only the active personal scope and rejects extra private payloads", async () => {
    const x = fixture();
    const req = request(x);
    await x.cache.save({
      ...req, snapshot
    });
    expect(await x.cache.clear(req)).toEqual({
      ok: true
    });
    expect(await x.cache.load(req)).toEqual({
      snapshot: null
    });
    expect(await x.cache.save({
      ...req, snapshot: {
        ...snapshot, transcript: "private"
      } as never
    })).toEqual({
      ok: false
    });
  });
  it("does not expose filesystem failures to renderers", async () => {
    const bad = join(dir, "not-a-directory");
    await writeFile(bad, "x");
    const x = createNavigationCache({
      dir: bad, getStatus: () => signedIn()
    });
    caches.push(x);
    const ctx = x.context();
    expect(await x.save({
      scope: ctx.scope!, authGeneration: ctx.authGeneration, snapshot
    })).toEqual({
      ok: false
    });
    expect(await x.load({
      scope: ctx.scope!, authGeneration: ctx.authGeneration
    })).toEqual({
      snapshot: null
    });
  });
});
describe("navigation IPC authority", () => {
  it("validates sender/frame, strict input and required dependencies before work", async () => {
    const x = fixture();
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    registerNavigationCacheIpc({
      handle: (c, f) => handlers.set(c, f)
    }, x.cache, event => event === "main");
    const req = request(x);
    await expect(handlers.get("navigation-cache:load")!("embed", req)).rejects.toThrow("invalid request");
    await expect(handlers.get("navigation-cache:save")!("main", {
      ...req, snapshot, ownerId: "other"
    })).rejects.toThrow("invalid request");
    expect(await handlers.get("navigation-cache:save")!("main", {
      ...req, snapshot
    })).toEqual({
      ok: true
    });
    expect(() => registerNavigationCacheIpc({
      handle: vi.fn()
    }, {} as never, () => true)).toThrow();
  });
});

it('rejects a truncated write without replacing the complete saved snapshot', async () => {
  const x = fixture();
  const req = request(x);
  expect(await x.cache.save({ ...req, snapshot })).toEqual({ ok: true });
  expect(await x.cache.save({ ...req, snapshot: { ...snapshot, truncated: true } })).toEqual({ ok: false });
  expect(await x.cache.load(req)).toEqual({ snapshot });
});
it('rejects and prunes truncated snapshots already on disk', async () => {
  const x = fixture();
  const req = request(x);
  await x.cache.save({ ...req, snapshot });
  const path = join(dir, 'navigation-cache', req.scope + '.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...envelope, snapshot: { ...snapshot, truncated: true } }));
  expect(await x.cache.load(req)).toEqual({ snapshot: null });
  await x.cache.drain();
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('sweeps abandoned files while idle, skips symlinks, and stops recurring work on drain', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const x = fixture();
  const req = request(x);
  await x.cache.save({ ...req, snapshot });
  const temp = join(dir, 'navigation-cache', req.scope + '.abcdef123456.tmp');
  const target = join(dir, 'owner-data');
  const link = join(dir, 'navigation-cache', req.scope + '.abcdef123457.tmp');
  await writeFile(target, 'preserve');
  await symlink(target, link);
  for (let attempt = 0; attempt < 2; attempt++) {
    await writeFile(temp, 'abandoned');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => { await expect(stat(temp)).rejects.toMatchObject({ code: 'ENOENT' }); });
    expect(await readFile(target, 'utf8')).toBe('preserve');
    expect(await readFile(link, 'utf8')).toBe('preserve');
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
  }
  await x.cache.drain();
  expect(vi.getTimerCount()).toBe(0);
  await writeFile(temp, 'after shutdown');
  await vi.advanceTimersByTimeAsync(600_000);
  expect(await readFile(temp, 'utf8')).toBe('after shutdown');
  expect(vi.getTimerCount()).toBe(0);
});
