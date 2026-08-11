import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch as chokidarWatch } from "chokidar";
import {
  createWatcher,
  createWatcherIgnored,
  createWatcherPaths,
  type WatcherBackend,
  type WatcherFactory,
} from "../../packages/gateway/src/watcher.js";

function createFakeWatcherFactory() {
  const backends: Array<WatcherBackend & {
    emit(event: string, path: string): void;
    add: ReturnType<typeof vi.fn>;
    unwatch: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const calls: Array<{ paths: string | string[]; options: Record<string, unknown> }> = [];
  const factory: WatcherFactory = (paths, options) => {
    const listeners = new Map<string, Array<(path: string) => void>>();
    const backend = {
      on: vi.fn((event: string, listener: (path: string) => void) => {
        const registered = listeners.get(event) ?? [];
        registered.push(listener);
        listeners.set(event, registered);
        return backend;
      }),
      add: vi.fn(() => backend),
      unwatch: vi.fn(async () => backend),
      close: vi.fn(async () => undefined),
      emit(event: string, path: string) {
        for (const listener of listeners.get(event) ?? []) listener(path);
      },
    } satisfies WatcherBackend & { emit(event: string, path: string): void };
    calls.push({ paths, options: options as unknown as Record<string, unknown> });
    backends.push(backend);
    return backend;
  };
  return { factory, backends, calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateway home watcher", () => {
  it("ignores large development and cache directories by default", () => {
    const ignored = createWatcherIgnored();

    expect(ignored("/home/user/projects/repo/file.ts")).toBe(true);
    expect(ignored("/home/user/matrix-os/something")).toBe(true);
    expect(ignored("/home/user/node_modules/foo")).toBe(true);
    expect(ignored("/home/user/.git/HEAD")).toBe(true);
    expect(ignored("/home/user/.claude/settings")).toBe(true);
    expect(ignored("/home/user/.codex/config")).toBe(true);
    expect(ignored("/home/user/.hermes/data")).toBe(true);
    expect(ignored("/home/user/.local/share")).toBe(true);
    expect(ignored("/home/user/.npm/cache")).toBe(true);
    expect(ignored("/home/user/system/matrix.db")).toBe(true);
    expect(ignored("/home/user/system/matrix.db-wal")).toBe(true);
  });

  it("allows normal home paths", () => {
    const ignored = createWatcherIgnored();

    expect(ignored("/home/user/apps/todo/index.html")).toBe(false);
    expect(ignored("/home/user/system/config.json")).toBe(false);
    expect(ignored("/home/user/agents/custom/builder.md")).toBe(false);
  });

  it("can opt back into watching projects without watching caches", () => {
    const ignored = createWatcherIgnored({ watchProjects: true });

    expect(ignored("/home/user/projects/repo/file.ts")).toBe(false);
    expect(ignored("/home/user/matrix-os/something")).toBe(false);

    expect(ignored("/home/user/node_modules/foo")).toBe(true);
    expect(ignored("/home/user/.git/HEAD")).toBe(true);
    expect(ignored("/home/user/.claude/settings")).toBe(true);
    expect(ignored("/home/user/.codex/config")).toBe(true);
  });

  it("matches directory names as path segments not substrings", () => {
    const ignored = createWatcherIgnored();

    expect(ignored("/home/user/apps/node_modules_info.txt")).toBe(false);
    expect(ignored("/home/user/apps/my-projects-list.md")).toBe(false);
  });

  it("only treats matrix database names as ignored file names", () => {
    const ignored = createWatcherIgnored({ watchProjects: true });

    expect(ignored("/home/user/system/matrix.db")).toBe(true);
    expect(ignored("/home/user/system/matrix.db-wal")).toBe(true);
    expect(ignored("/home/user/apps/matrix.db-backups/config.json")).toBe(false);
  });

  it("watches bounded Matrix-owned roots instead of the whole home", () => {
    expect(createWatcherPaths("/home/matrix/home")).toEqual(expect.arrayContaining([
      "/home/matrix/home/apps",
      "/home/matrix/home/data",
      "/home/matrix/home/system",
      "/home/matrix/home/.matrix-version",
    ]));
    expect(createWatcherPaths("/home/matrix/home")).not.toContain("/home/matrix/home");
    expect(createWatcherPaths("/home/matrix/home")).not.toContain("/home/matrix/home/projects");
    expect(createWatcherPaths("/home/matrix/home")).not.toContain("/home/matrix/home/matrix-os");
  });

  it("lazily watches only the exact projects directory at depth zero", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    await mkdir(join(homePath, "projects"));
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, { watchFactory: fake.factory });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].paths).not.toContain(join(homePath, "projects"));

    const release = await watcher.acquireDirectoryScope("projects");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].paths).toBe(join(homePath, "projects"));
    expect(fake.calls[1].options).toMatchObject({
      depth: 0,
      ignoreInitial: true,
      followSymlinks: false,
    });
    const ignored = fake.calls[1].options.ignored as (path: string) => boolean;
    expect(ignored(join(homePath, "projects", "demo"))).toBe(false);
    expect(ignored(join(homePath, "projects", "demo", "node_modules"))).toBe(true);

    await release();
    expect(fake.backends[1].unwatch).toHaveBeenCalledWith(join(homePath, "projects"));
    await watcher.close();
    await rm(homePath, { recursive: true });
  });

  it("reference-counts exact scopes and emits direct file and directory hints", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    await mkdir(join(homePath, "projects"));
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, { watchFactory: fake.factory });
    const listener = vi.fn();
    watcher.on(listener);

    const firstRelease = await watcher.acquireDirectoryScope("projects");
    const secondRelease = await watcher.acquireDirectoryScope("projects");
    expect(fake.calls).toHaveLength(2);

    fake.backends[1].emit("add", join(homePath, "projects", "file.txt"));
    fake.backends[1].emit("change", join(homePath, "projects", "file.txt"));
    fake.backends[1].emit("unlink", join(homePath, "projects", "file.txt"));
    fake.backends[1].emit("addDir", join(homePath, "projects", "new-folder"));
    fake.backends[1].emit("unlinkDir", join(homePath, "projects", "old-folder"));
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "file:change", path: "projects/file.txt", event: "add" },
      { type: "file:change", path: "projects/file.txt", event: "change" },
      { type: "file:change", path: "projects/file.txt", event: "unlink" },
      { type: "file:change", path: "projects/new-folder", event: "add" },
      { type: "file:change", path: "projects/old-folder", event: "unlink" },
    ]);

    await firstRelease();
    expect(fake.backends[1].unwatch).not.toHaveBeenCalled();
    await secondRelease();
    expect(fake.backends[1].unwatch).toHaveBeenCalledOnce();
    await watcher.close();
    await rm(homePath, { recursive: true });
  });

  it("waits for the last unwatch before reacquiring the same exact scope", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    await mkdir(join(homePath, "projects"));
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, { watchFactory: fake.factory });
    const release = await watcher.acquireDirectoryScope("projects");
    const unwatchGate = deferred<WatcherBackend>();
    fake.backends[1].unwatch.mockImplementationOnce(() => unwatchGate.promise);

    const releasePromise = release();
    await vi.waitFor(() => expect(fake.backends[1].unwatch).toHaveBeenCalledOnce());
    const reacquirePromise = watcher.acquireDirectoryScope("projects");
    const reacquiredBeforeUnwatch = await Promise.race([
      reacquirePromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(reacquiredBeforeUnwatch).toBe(false);
    expect(fake.backends[1].add).not.toHaveBeenCalled();

    unwatchGate.resolve(fake.backends[1]);
    await releasePromise;
    const reacquiredRelease = await reacquirePromise;
    expect(fake.backends[1].add).toHaveBeenCalledOnce();
    await reacquiredRelease();
    await watcher.close();
    await rm(homePath, { recursive: true });
  });

  it("drains an in-flight scoped unwatch before closing watcher backends", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    await mkdir(join(homePath, "projects"));
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, { watchFactory: fake.factory });
    const release = await watcher.acquireDirectoryScope("projects");
    const unwatchGate = deferred<WatcherBackend>();
    fake.backends[1].unwatch.mockImplementationOnce(() => unwatchGate.promise);
    const releasePromise = release();
    await vi.waitFor(() => expect(fake.backends[1].unwatch).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closePromise = watcher.close().then(() => { closeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
    expect(fake.backends[1].close).not.toHaveBeenCalled();

    unwatchGate.resolve(fake.backends[1]);
    await Promise.all([releasePromise, closePromise]);
    expect(fake.backends[1].close).toHaveBeenCalledOnce();
    expect(fake.backends[0].close).toHaveBeenCalledOnce();
    await rm(homePath, { recursive: true });
  });

  it("drains gated scope validation and prevents a late backend after close", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    await mkdir(join(homePath, "projects"));
    const fake = createFakeWatcherFactory();
    const validationGate = deferred<string>();
    const validateDirectoryScope = vi.fn(async () => validationGate.promise);
    const watcher = createWatcher(homePath, {
      watchFactory: fake.factory,
      validateDirectoryScope,
    } as never);
    const acquisition = watcher.acquireDirectoryScope("projects");
    const duplicateAcquisition = watcher.acquireDirectoryScope("projects");
    await vi.waitFor(() => expect(validateDirectoryScope).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closeDrain = watcher.close();
    const closePromise = closeDrain.then(() => { closeSettled = true; });
    const sharedClosePromise = watcher.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
    expect(sharedClosePromise).toBe(closeDrain);
    validationGate.resolve(join(homePath, "projects"));

    await Promise.all([closePromise, sharedClosePromise]);
    await expect(acquisition).rejects.toThrow("closed");
    await expect(duplicateAcquisition).rejects.toThrow("closed");
    expect(validateDirectoryScope).toHaveBeenCalledOnce();
    expect(fake.backends).toHaveLength(1);
    expect(fake.backends[0].close).toHaveBeenCalledOnce();
    await rm(homePath, { recursive: true });
  });

  it("suppresses only exact root overlap emitted by global and scoped backends", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, { watchFactory: fake.factory });
    const listener = vi.fn();
    watcher.on(listener);
    const release = await watcher.acquireDirectoryScope("");

    fake.backends[0].emit("change", join(homePath, "CLAUDE.md"));
    fake.backends[1].emit("change", join(homePath, "CLAUDE.md"));
    fake.backends[1].emit("add", join(homePath, "notes.txt"));
    fake.backends[1].emit("addDir", join(homePath, "projects"));
    fake.backends[1].emit("unlinkDir", join(homePath, "projects"));
    fake.backends[0].emit("unlinkDir", join(homePath, "apps"));
    fake.backends[1].emit("unlinkDir", join(homePath, "apps"));
    fake.backends[1].emit("addDir", join(homePath, "apps"));
    fake.backends[0].emit("addDir", join(homePath, "apps"));
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "file:change", path: "CLAUDE.md", event: "change" },
      { type: "file:change", path: "notes.txt", event: "add" },
      { type: "file:change", path: "projects", event: "add" },
      { type: "file:change", path: "projects", event: "unlink" },
      { type: "file:change", path: "apps", event: "unlink" },
      { type: "file:change", path: "apps", event: "add" },
    ]);

    await release();
    await watcher.close();
    await rm(homePath, { recursive: true });
  });

  it("keeps unmatched, same-source, and different-event root hints", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, { watchFactory: fake.factory });
    const listener = vi.fn();
    watcher.on(listener);
    const release = await watcher.acquireDirectoryScope("");

    fake.backends[1].emit("change", join(homePath, "CLAUDE.md"));
    fake.backends[1].emit("change", join(homePath, "CLAUDE.md"));
    fake.backends[1].emit("unlink", join(homePath, "CLAUDE.md"));
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "file:change", path: "CLAUDE.md", event: "change" },
      { type: "file:change", path: "CLAUDE.md", event: "change" },
      { type: "file:change", path: "CLAUDE.md", event: "unlink" },
    ]);

    await release();
    await watcher.close();
    await rm(homePath, { recursive: true });
  });

  it("correlates every opposite-source token in both source orders", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, { watchFactory: fake.factory });
    const listener = vi.fn();
    watcher.on(listener);
    const release = await watcher.acquireDirectoryScope("");
    const claudePath = join(homePath, "CLAUDE.md");

    fake.backends[0].emit("change", claudePath);
    fake.backends[0].emit("change", claudePath);
    fake.backends[1].emit("change", claudePath);
    fake.backends[1].emit("change", claudePath);
    fake.backends[1].emit("unlink", claudePath);
    fake.backends[1].emit("unlink", claudePath);
    fake.backends[0].emit("unlink", claudePath);
    fake.backends[0].emit("unlink", claudePath);
    expect(listener.mock.calls.map(([event]) => event.event)).toEqual([
      "change", "change", "unlink", "unlink",
    ]);

    await release();
    await watcher.close();
    await rm(homePath, { recursive: true });
  });

  it("does not correlate opposite-source root hints after the bounded window", async () => {
    let now = 0;
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, {
      watchFactory: fake.factory,
      now: () => now,
      rootCorrelationWindowMs: 100,
    });
    const listener = vi.fn();
    watcher.on(listener);
    const release = await watcher.acquireDirectoryScope("");

    fake.backends[0].emit("change", join(homePath, "CLAUDE.md"));
    now = 101;
    fake.backends[1].emit("change", join(homePath, "CLAUDE.md"));
    expect(listener).toHaveBeenCalledTimes(2);

    await release();
    await watcher.close();
    await rm(homePath, { recursive: true });
  });

  it("emits one real hint for a root file covered by both watcher backends", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-real-"));
    await writeFile(join(homePath, "CLAUDE.md"), "one");
    const ready: Array<Promise<void>> = [];
    const realFactory: WatcherFactory = (paths, options) => {
      const backend = chokidarWatch(paths, { ...options, usePolling: false });
      ready.push(new Promise<void>((resolve) => { backend.once("ready", () => resolve()); }));
      return backend as WatcherBackend;
    };
    const watcher = createWatcher(homePath, { watchFactory: realFactory });
    const listener = vi.fn();
    watcher.on(listener);
    const release = await watcher.acquireDirectoryScope("");
    await Promise.all(ready);

    await writeFile(join(homePath, "CLAUDE.md"), "two");
    await vi.waitFor(() => {
      expect(listener.mock.calls.filter(([event]) => event.path === "CLAUDE.md")).toHaveLength(1);
    }, { timeout: 2_000 });

    await release();
    await watcher.close();
    await rm(homePath, { recursive: true });
  });

  it("uses existing global coverage and closes both watcher backends", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const homePath = await mkdtemp(join(tmpdir(), "matrix-watcher-"));
    await mkdir(join(homePath, "apps", "todo"), { recursive: true });
    const fake = createFakeWatcherFactory();
    const watcher = createWatcher(homePath, { watchFactory: fake.factory });

    const releaseCovered = await watcher.acquireDirectoryScope("apps/todo");
    expect(fake.calls).toHaveLength(1);
    await releaseCovered();
    await expect(watcher.acquireDirectoryScope("missing")).rejects.toThrow("Invalid directory scope");
    expect(fake.calls).toHaveLength(1);

    await watcher.acquireDirectoryScope("");
    expect(fake.calls).toHaveLength(2);
    await watcher.close();
    expect(fake.backends[0].close).toHaveBeenCalledOnce();
    expect(fake.backends[1].close).toHaveBeenCalledOnce();
    await rm(homePath, { recursive: true });
  });
});
