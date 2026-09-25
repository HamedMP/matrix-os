import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHomeMirror as createHomeMirrorImpl } from "../../../packages/gateway/src/sync/home-mirror.js";
import {
  createPeerRegistry,
  type PeerRegistry,
} from "../../../packages/gateway/src/sync/ws-events.js";
import type { R2Client } from "../../../packages/gateway/src/sync/r2-client.js";
import {
  applyCommitToManifest,
  readManifest,
  writeManifest,
  type ManifestDb,
} from "../../../packages/gateway/src/sync/manifest.js";
import { resolveSyncScope } from "../../../packages/gateway/src/sync/runtime-scope.js";

function sha256(buf: Buffer): string {
  const { createHash } = require("node:crypto");
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function storedManifest(r2: { store: Map<string, Buffer> }, owner = "alice") {
  const prefix = `matrixos-sync/${owner}/manifests/`;
  const candidates = [...r2.store.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, raw]) => JSON.parse(raw.toString("utf8")) as {
      manifestVersion?: number;
      files: Record<string, { hash: string; size: number; objectKey?: string }>;
    })
    .sort((left, right) => (right.manifestVersion ?? 0) - (left.manifestVersion ?? 0));
  return candidates[0] ?? null;
}

// Minimal in-memory R2 stub -- we only exercise getObject/putObject/deleteObject
// since home-mirror routes everything through those.
function createFakeR2(): R2Client & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async getObject(key: string) {
      const buf = store.get(key);
      if (!buf) throw new Error(`NoSuchKey: ${key}`);
      return {
        body: {
          async transformToByteArray() {
            return new Uint8Array(buf);
          },
          async text() {
            return buf.toString("utf8");
          },
        } as unknown as ReadableStream,
        etag: `"etag-${key}"`,
      };
    },
    async putObject(key: string, body: string | Uint8Array | AsyncIterable<Uint8Array>) {
      let bytes: Buffer;
      if (typeof body === "string" || body instanceof Uint8Array) {
        bytes = Buffer.from(body);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        bytes = Buffer.concat(chunks);
      }
      store.set(key, bytes);
      return { etag: `"etag-${key}-${store.size}"` };
    },
    async deleteObject(key: string) {
      store.delete(key);
    },
    async getPresignedGetUrl() {
      return "http://fake/get";
    },
    async getPresignedPutUrl() {
      return "http://fake/put";
    },
    destroy() {},
  } as unknown as R2Client & { store: Map<string, Buffer> };
}

function createFakeManifestDb(): ManifestDb {
  let meta: Awaited<ReturnType<ManifestDb["getManifestMeta"]>> = null;
  return {
    async getManifestMeta() {
      return meta;
    },
    async upsertManifestMeta(_scope, next) {
      meta = { ...next, updated_at: new Date() };
    },
    async advanceManifestMeta(_scope, expectedVersion, next) {
      if ((meta?.version ?? 0) !== expectedVersion) return false;
      meta = { ...next, updated_at: new Date() };
      return true;
    },
    async withAdvisoryLock<T>(
      _userId: string,
      fn: (executor: unknown) => Promise<T>,
    ): Promise<T> {
      return fn(undefined);
    },
  } as unknown as ManifestDb;
}

async function settle(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await settle(50);
  }
  throw new Error("Timed out waiting for condition");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createHomeMirror", () => {
  let tmpRoot: string;
  let r2: ReturnType<typeof createFakeR2>;
  let db: ManifestDb;
  let registry: PeerRegistry;
  let activeMirrors: Array<ReturnType<typeof createHomeMirrorImpl>>;

  function createHomeMirror(
    ...args: Parameters<typeof createHomeMirrorImpl>
  ): ReturnType<typeof createHomeMirrorImpl> {
    const mirror = createHomeMirrorImpl(...args);
    activeMirrors.push(mirror);
    return mirror;
  }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "home-mirror-test-"));
    r2 = createFakeR2();
    db = createFakeManifestDb();
    registry = createPeerRegistry();
    activeMirrors = [];
  });

  afterEach(async () => {
    let stopError: unknown;
    for (const mirror of [...activeMirrors].reverse()) {
      try {
        await mirror.stop();
      } catch (err: unknown) {
        stopError ??= err;
      }
    }
    activeMirrors = [];
    await rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    if (stopError) {
      throw stopError;
    }
  });

  describe("subscribe-to-broadcasts", () => {
    it("downloads a file when another peer broadcasts sync:change", async () => {
      // Seed R2 with the file another peer "uploaded".
      const content = Buffer.from("hello from laptop");
      const key = `matrixos-sync/alice/files/notes/foo.md`;
      r2.store.set(key, content);

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      // Simulate another peer committing -- broadcasts arrive at all
      // registered peers EXCEPT the sender.
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: "notes/foo.md", hash: sha256(content), size: content.length, action: "update" }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });

      // Give the async enqueue a tick to process.
      await settle(80);

      const written = await readFile(join(tmpRoot, "notes/foo.md"));
      expect(written.equals(content)).toBe(true);

      await mirror.stop();
    });

    it("rejects downloaded content whose hash does not match the manifest entry", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const content = Buffer.from("corrupted-or-stale");
      r2.store.set("matrixos-sync/alice/files/notes/bad.md", content);

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      await mirror.start();

      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{
          path: "notes/bad.md",
          hash: sha256(Buffer.from("expected-different-content")),
          size: content.length,
          action: "update",
        }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });

      await settle(80);

      await expect(stat(join(tmpRoot, "notes/bad.md"))).rejects.toThrow(/ENOENT/);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("remote-change failed for notes/bad.md:"),
        expect.stringContaining("hash"),
      );

      await mirror.stop();
    });

    it("fails startup after an incomplete initial pull without subscribing", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const content = Buffer.from("startup payload");
      const originalGetObject = r2.getObject.bind(r2);
      r2.store.set(
        "matrixos-sync/alice/manifest.json",
        Buffer.from(JSON.stringify({
          version: 2,
          files: {
            "notes/startup.md": {
              hash: sha256(content),
              size: content.length,
              mtime: Date.now(),
              peerId: "laptop-1",
              version: 1,
            },
          },
        })),
      );
      db = {
        async getManifestMeta() {
          return {
            version: 1,
            file_count: 1,
            total_size: BigInt(content.length),
            etag: '"etag"',
            updated_at: new Date(),
          };
        },
        async upsertManifestMeta() {},
        async withAdvisoryLock<T>(_userId: string, fn: (executor: unknown) => Promise<T>) {
          return fn(undefined);
        },
      } as unknown as ManifestDb;
      vi.spyOn(r2, "getObject").mockImplementation(async (key: string) => {
        if (key === "matrixos-sync/alice/files/notes/startup.md") {
          throw "non-error initial pull failure";
        }
        return originalGetObject(key);
      });

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      await expect(mirror.start()).rejects.toThrow("initial pull incomplete");

      expect(logger.error).toHaveBeenCalledWith(
        "pull failed for notes/startup.md:",
        "non-error initial pull failure",
      );
      expect(registry.getPeers("alice")).toEqual([]);

      await mirror.stop();
    });

    it("rejects remote files that exceed the auto-sync byte cap", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const content = Buffer.from("oversized");
      const getObject = vi.spyOn(r2, "getObject");
      r2.store.set("matrixos-sync/alice/files/notes/huge.md", content);

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
        maxPushBytes: 4,
      });
      await mirror.start();

      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{
          path: "notes/huge.md",
          hash: sha256(content),
          size: content.length,
          action: "update",
        }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });

      await settle(80);

      await expect(stat(join(tmpRoot, "notes/huge.md"))).rejects.toThrow(/ENOENT/);
      expect(getObject).not.toHaveBeenCalledWith("matrixos-sync/alice/files/notes/huge.md");
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("remote-change failed for notes/huge.md:"),
        expect.stringContaining("exceeds 4 bytes"),
      );

      await mirror.stop();
    });

    it("deletes a local file when a sync:change action=delete arrives", async () => {
      // Prep a local file we expect to be deleted.
      await mkdir(join(tmpRoot, "notes"), { recursive: true });
      await writeFile(join(tmpRoot, "notes/bar.md"), "to be removed");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: "notes/bar.md", hash: "sha256:" + "0".repeat(64), size: 0, action: "delete" }],
        peerId: "laptop-1",
        manifestVersion: 3,
      });

      await settle(80);

      await expect(stat(join(tmpRoot, "notes/bar.md"))).rejects.toThrow(/ENOENT/);
      await mirror.stop();
    });

    it("refuses to delete symlinks on remote delete events", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const target = join(tmpRoot, "real.txt");
      const link = join(tmpRoot, "notes-link");
      await writeFile(target, "keep me");
      await (await import("node:fs/promises")).symlink(target, link);

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      await mirror.start();

      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: "notes-link", hash: "sha256:" + "0".repeat(64), size: 0, action: "delete" }],
        peerId: "laptop-1",
        manifestVersion: 3,
      });

      await settle(80);

      expect(logger.error).toHaveBeenCalledWith("refusing to delete symlink notes-link");
      const linkStat = await (await import("node:fs/promises")).lstat(link);
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf-8")).toBe("keep me");

      await mirror.stop();
    });

    it("logs remote delete failures instead of swallowing them", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      await mkdir(join(tmpRoot, "notes", "blocked"), { recursive: true });

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      await mirror.start();

      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: "notes/blocked", hash: "sha256:" + "0".repeat(64), size: 0, action: "delete" }],
        peerId: "laptop-1",
        manifestVersion: 3,
      });

      await settle(80);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("remote-change failed for notes/blocked:"),
        expect.any(String),
      );
      await mirror.stop();
    });

    it("logs malformed peer broadcasts instead of silently swallowing them", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      let subscriber: { send(data: string): void } | null = null;
      const peerRegistry = {
        registerPeer(_userId, _params, ws) {
          subscriber = ws;
          return {
            peerId: "gateway-alice",
            userId: "alice",
            hostname: "gateway",
            platform: "linux",
            clientVersion: "home-mirror",
            connectedAt: Date.now(),
          };
        },
        removePeer() {},
        broadcastChange() {},
        sendToUser() {},
        getPeers() {
          return [];
        },
        getTotalPeerCount() {
          return 0;
        },
      } as unknown as PeerRegistry;

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry,
        logger,
      });
      await mirror.start();

      subscriber?.send("{not-json");

      expect(logger.error).toHaveBeenCalledWith(
        "ignored malformed peer broadcast:",
        expect.any(String),
      );

      await mirror.stop();
    });

    it("logs invalid sync:change payloads instead of trusting their shape", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      let subscriber: { send(data: string): void } | null = null;
      const peerRegistry = {
        registerPeer(_userId, _params, ws) {
          subscriber = ws;
          return {
            peerId: "gateway-alice",
            userId: "alice",
            hostname: "gateway",
            platform: "linux",
            clientVersion: "home-mirror",
            connectedAt: Date.now(),
          };
        },
        removePeer() {},
        broadcastChange() {},
        sendToUser() {},
        getPeers() {
          return [];
        },
        getTotalPeerCount() {
          return 0;
        },
      } as unknown as PeerRegistry;

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry,
        logger,
      });
      await mirror.start();

      subscriber?.send(JSON.stringify({
        type: "sync:change",
        files: [{ path: "notes/oops.md", hash: "bad-hash", size: "wrong" }],
      }));

      expect(logger.error).toHaveBeenCalledWith(
        "ignored malformed peer broadcast:",
        expect.any(String),
      );

      await mirror.stop();
    });

    it("refuses traversal paths on remote writes", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const outsideRoot = await mkdtemp(join(tmpdir(), "home-mirror-outside-"));
      const outsidePath = join(outsideRoot, "escaped-write.txt");
      const traversalPath = relative(tmpRoot, outsidePath);
      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      try {
        await mirror.start();

        registry.broadcastChange("alice", "laptop-1", {
          type: "sync:change",
          files: [{ path: traversalPath, hash: sha256(Buffer.from("evil")), size: 4, action: "update" }],
          peerId: "laptop-1",
          manifestVersion: 2,
        });

        await settle(80);

        await expect(stat(outsidePath)).rejects.toThrow(/ENOENT/);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining(`remote-change failed for ${traversalPath}:`),
          expect.stringMatching(/invalid/i),
        );
      } finally {
        await mirror.stop();
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });

    it("does not follow local symlinks on remote writes", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const outsideRoot = await mkdtemp(join(tmpdir(), "home-mirror-outside-"));
      const target = join(outsideRoot, "outside-target.txt");
      const link = join(tmpRoot, "linked.txt");
      await writeFile(target, "outside");
      await (await import("node:fs/promises")).symlink(target, link);
      r2.store.set(
        "matrixos-sync/alice/files/linked.txt",
        Buffer.from("replacement"),
      );

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      try {
        await mirror.start();

        registry.broadcastChange("alice", "laptop-1", {
          type: "sync:change",
          files: [{ path: "linked.txt", hash: sha256(Buffer.from("replacement")), size: 11, action: "update" }],
          peerId: "laptop-1",
          manifestVersion: 2,
        });

        await settle(80);

        expect(await readFile(target, "utf8")).toBe("outside");
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("remote-change failed for linked.txt:"),
          expect.stringMatching(/symlink/i),
        );
      } finally {
        await mirror.stop();
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });

    it("logs non-Error failures during remote pulls without losing the reason", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const originalGetObject = r2.getObject.bind(r2);
      vi.spyOn(r2, "getObject").mockImplementation(async (key: string) => {
        if (key === "matrixos-sync/alice/files/notes/string-failure.md") {
          throw "non-error remote pull failure";
        }
        return originalGetObject(key);
      });

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      await mirror.start();

      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{
          path: "notes/string-failure.md",
          hash: sha256(Buffer.from("replacement")),
          size: 11,
          action: "update",
        }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });

      await settle(80);

      expect(logger.error).toHaveBeenCalledWith(
        "remote-change failed for notes/string-failure.md:",
        "non-error remote pull failure",
      );

      await mirror.stop();
    });

    it("does not write through symlinked parent directories on remote writes", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const outsideRoot = await mkdtemp(join(tmpdir(), "home-mirror-outside-"));
      try {
        await (await import("node:fs/promises")).symlink(
          outsideRoot,
          join(tmpRoot, "projects"),
        );
        const remoteContent = Buffer.from("blocked write");
        r2.store.set(
          "matrixos-sync/alice/files/projects/crontab",
          remoteContent,
        );

        const mirror = createHomeMirror({
          r2,
          manifestDb: db,
          homeRoot: tmpRoot,
          userId: "alice",
          peerId: "gateway-alice",
          peerRegistry: registry,
          logger,
        });
        await mirror.start();

        registry.broadcastChange("alice", "laptop-1", {
          type: "sync:change",
          files: [{
            path: "projects/crontab",
            hash: sha256(remoteContent),
            size: remoteContent.length,
            action: "update",
          }],
          peerId: "laptop-1",
          manifestVersion: 2,
        });

        await settle(80);

        await expect(stat(join(outsideRoot, "crontab"))).rejects.toThrow(/ENOENT/);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("remote-change failed for projects/crontab:"),
          expect.stringContaining("symlinked parent path"),
        );

        await mirror.stop();
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });

    it("refuses traversal paths on remote deletes", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const outsideRoot = await mkdtemp(join(tmpdir(), "home-mirror-outside-"));
      const outsidePath = join(outsideRoot, "escaped-delete.txt");
      const traversalPath = relative(tmpRoot, outsidePath);
      await writeFile(outsidePath, "keep me");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      try {
        await mirror.start();

        registry.broadcastChange("alice", "laptop-1", {
          type: "sync:change",
          files: [{ path: traversalPath, hash: "sha256:" + "0".repeat(64), size: 0, action: "delete" }],
          peerId: "laptop-1",
          manifestVersion: 2,
        });

        await settle(80);

        const remaining = await readFile(outsidePath, "utf8");
        expect(remaining).toBe("keep me");
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining(`remote-change failed for ${traversalPath}:`),
          expect.stringMatching(/invalid/i),
        );
      } finally {
        await mirror.stop();
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });

    it("ignores broadcasts for ignored paths (e.g. node_modules and browser profiles)", async () => {
      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      const putObject = vi.spyOn(r2, "putObject");
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: "node_modules/evil.js", hash: "sha256:" + "0".repeat(64), size: 10, action: "update" }],
        peerId: "laptop-1",
        manifestVersion: 4,
      });
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{
          path: "data/browser-profiles/default/Cookies",
          hash: "sha256:" + "0".repeat(64),
          size: 10,
          action: "update",
        }],
        peerId: "laptop-1",
        manifestVersion: 5,
      });
      await settle(40);

      // The file must not have been downloaded -- there's no R2 entry for it
      // and no attempt to fetch.
      await expect(stat(join(tmpRoot, "node_modules/evil.js"))).rejects.toThrow(/ENOENT/);
      await expect(stat(join(tmpRoot, "data/browser-profiles/default/Cookies"))).rejects.toThrow(/ENOENT/);
      expect(putObject).not.toHaveBeenCalled();
      await mirror.stop();
    });

    it("broadcasts sync:change to other peers when a local file is pushed", async () => {
      // Register a second peer so broadcastChange actually has someone to
      // deliver to. Peer messages are fire-and-forget strings on a shared
      // SyncPeerConnection.send mock.
      const laptopSends: string[] = [];
      registry.registerPeer(
        "alice",
        { peerId: "laptop-1", hostname: "mbp", platform: "darwin", clientVersion: "0.1.0" },
        {
          readyState: 1,
          send(data: string) {
            laptopSends.push(data);
          },
        },
      );

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      // Drop a file in the container's home -- mirror should upload AND
      // broadcast. Chokidar + awaitWriteFinish (250ms) + fsevents startup
      // latency is ~1.5s locally but variable on CI, so poll rather than
      // sleep a fixed interval.
      await writeFile(join(tmpRoot, "new.md"), "container wrote this");
      await waitFor(() =>
        laptopSends.some((s) => s.includes('"sync:change"') && s.includes("new.md")),
      );

      const syncChanges = laptopSends.filter((s) => s.includes('"sync:change"'));
      expect(syncChanges.length).toBeGreaterThan(0);
      expect(syncChanges.some((s) => s.includes("new.md"))).toBe(true);

      await mirror.stop();
    });

    it("does not leave a peer subscription behind when stopped during startup", async () => {
      const manifestRead = deferred<void>();
      const getObject = vi.spyOn(r2, "getObject").mockImplementation(async (key: string) => {
        if (key === "matrixos-sync/alice/manifest.json") {
          await manifestRead.promise;
          const err = Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
          throw err;
        }
        throw new Error(`unexpected key: ${key}`);
      });

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });

      const startPromise = mirror.start();
      await settle(20);
      await mirror.stop();
      manifestRead.resolve();
      await startPromise;

      expect(registry.getPeers("alice")).toHaveLength(0);
      getObject.mockRestore();
    });

    it("pushes existing local-only files during startup without relying on watcher replay", async () => {
      await writeFile(join(tmpRoot, "preexisting.md"), "present before watcher starts");

      const laptopSends: string[] = [];
      registry.registerPeer(
        "alice",
        { peerId: "laptop-1", hostname: "mbp", platform: "darwin", clientVersion: "0.1.0" },
        {
          readyState: 1,
          send(data: string) {
            laptopSends.push(data);
          },
        },
      );

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      await waitFor(() => Boolean(storedManifest(r2)?.files["preexisting.md"]?.objectKey));

      expect(laptopSends.some((s) => s.includes("preexisting.md"))).toBe(true);
      await mirror.stop();
    });

    it("keeps browser profile files out of startup and explicit local pushes", async () => {
      await mkdir(join(tmpRoot, "data/browser-profiles/default"), { recursive: true });
      await writeFile(join(tmpRoot, "data/browser-profiles/default/Cookies"), "login state");
      await writeFile(join(tmpRoot, "preexisting.md"), "present before watcher starts");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
      });
      await mirror.start();

      await waitFor(() => Boolean(storedManifest(r2)?.files["preexisting.md"]?.objectKey));
      expect(r2.store.has("matrixos-sync/alice/files/data/browser-profiles/default/Cookies")).toBe(false);

      await writeFile(join(tmpRoot, "data/browser-profiles/default/Local State"), "more profile state");
      await mirror.pushLocalFile("data/browser-profiles/default/Local State");
      await writeFile(join(tmpRoot, "after-start.md"), "local push is active");
      await mirror.pushLocalFile("after-start.md");

      expect(r2.store.has("matrixos-sync/alice/files/data/browser-profiles/default/Local State")).toBe(false);
      const afterStartKey = storedManifest(r2)?.files["after-start.md"]?.objectKey;
      expect(afterStartKey).toBeDefined();
      expect(r2.store.has(afterStartKey!)).toBe(true);
      await mirror.stop();
    });

    it("hard-excludes credential files and private key directories", async () => {
      await mkdir(join(tmpRoot, ".ssh"), { recursive: true });
      await mkdir(join(tmpRoot, ".claude"), { recursive: true });
      await mkdir(join(tmpRoot, "notes"), { recursive: true });
      await writeFile(join(tmpRoot, ".ssh", "id_ed25519"), "private key");
      await writeFile(join(tmpRoot, ".claude", ".credentials.json"), "oauth secret");
      await writeFile(join(tmpRoot, "notes", "client.pem"), "private pem");
      await writeFile(join(tmpRoot, "notes", "safe.md"), "safe");
      await writeFile(
        join(tmpRoot, ".syncignore"),
        "!.ssh/id_ed25519\n!.claude/.credentials.json\n!notes/client.pem\n",
      );

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
      });
      await mirror.start();

      const manifest = storedManifest(r2);
      expect(manifest?.files["notes/safe.md"]?.objectKey).toBeDefined();
      expect(manifest?.files[".ssh/id_ed25519"]).toBeUndefined();
      expect(manifest?.files[".claude/.credentials.json"]).toBeUndefined();
      expect(manifest?.files["notes/client.pem"]).toBeUndefined();
      await mirror.stop();
    });

    it("applies owner .syncignore globs and negations to startup, explicit pushes, and remote broadcasts", async () => {
      await mkdir(join(tmpRoot, "projects", "large"), { recursive: true });
      await mkdir(join(tmpRoot, "buzz"), { recursive: true });
      await mkdir(join(tmpRoot, "notes"), { recursive: true });
      await writeFile(
        join(tmpRoot, ".syncignore"),
        "projects/\nbuzz/\ncredentials.*\n*.bak\n!keep.bak\n",
      );
      await writeFile(join(tmpRoot, "projects", "large", "source.ts"), "ignored project");
      await writeFile(join(tmpRoot, "buzz", "generated.bin"), "ignored tree");
      await writeFile(join(tmpRoot, "notes", "old.bak"), "ignored backup");
      await writeFile(join(tmpRoot, "notes", "keep.bak"), "restored backup");
      await writeFile(join(tmpRoot, "notes", "credentials.json"), "ignored credential glob");
      await writeFile(join(tmpRoot, "notes", "safe.md"), "safe");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
      });
      await mirror.start();

      const manifest = storedManifest(r2);
      expect(manifest?.files["notes/safe.md"]?.objectKey).toBeDefined();
      expect(manifest?.files["projects/large/source.ts"]).toBeUndefined();
      expect(manifest?.files["buzz/generated.bin"]).toBeUndefined();
      expect(manifest?.files["notes/old.bak"]).toBeUndefined();
      expect(manifest?.files["notes/credentials.json"]).toBeUndefined();
      expect(manifest?.files["notes/keep.bak"]?.objectKey).toBeDefined();

      await writeFile(join(tmpRoot, "projects", "large", "later.ts"), "ignored later");
      await mirror.pushLocalFile("projects/large/later.ts");
      expect(storedManifest(r2)?.files["projects/large/later.ts"]).toBeUndefined();

      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{
          path: "projects/large/remote.ts",
          hash: sha256(Buffer.from("remote")),
          size: 6,
          action: "update",
        }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });
      await settle(80);
      await expect(stat(join(tmpRoot, "projects", "large", "remote.ts"))).rejects.toThrow(/ENOENT/);
      await mirror.stop();
    });

    it("loads a remote .syncignore before the initial pull and reloads later remote updates", async () => {
      const initialIgnore = Buffer.from("private/\n");
      const initialSecret = Buffer.from("must stay remote");
      const ignoreKey = "matrixos-sync/alice/files/.syncignore";
      const initialSecretKey = "matrixos-sync/alice/files/private/secret.txt";
      r2.store.set(ignoreKey, initialIgnore);
      r2.store.set(initialSecretKey, initialSecret);
      r2.store.set(
        "matrixos-sync/alice/manifest.json",
        Buffer.from(JSON.stringify({
          version: 2,
          manifestVersion: 1,
          files: {
            ".syncignore": {
              hash: sha256(initialIgnore),
              size: initialIgnore.length,
              mtime: Date.now(),
              peerId: "laptop-1",
              version: 1,
              objectKey: ignoreKey,
            },
            "private/secret.txt": {
              hash: sha256(initialSecret),
              size: initialSecret.length,
              mtime: Date.now(),
              peerId: "laptop-1",
              version: 1,
              objectKey: initialSecretKey,
            },
          },
        })),
      );

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
      });
      await mirror.start();

      expect(await readFile(join(tmpRoot, ".syncignore"), "utf8")).toBe("private/\n");
      await expect(stat(join(tmpRoot, "private", "secret.txt"))).rejects.toThrow(/ENOENT/);

      const updatedIgnore = Buffer.from("later/\n");
      r2.store.set(ignoreKey, updatedIgnore);
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{
          path: ".syncignore",
          hash: sha256(updatedIgnore),
          size: updatedIgnore.length,
          action: "update",
        }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });
      await settle(80);

      const later = Buffer.from("still ignored");
      const laterKey = "matrixos-sync/alice/files/later/remote.txt";
      r2.store.set(laterKey, later);
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{
          path: "later/remote.txt",
          hash: sha256(later),
          size: later.length,
          action: "update",
        }],
        peerId: "laptop-1",
        manifestVersion: 3,
      });
      await settle(80);

      await expect(stat(join(tmpRoot, "later", "remote.txt"))).rejects.toThrow(/ENOENT/);
      await mirror.stop();
    });

    it("syncs negated descendants of ignored directories without walking pruned siblings", async () => {
      await mkdir(join(tmpRoot, "projects", "large"), { recursive: true });
      await writeFile(join(tmpRoot, ".syncignore"), "projects/\n!projects/keep.md\n");
      await writeFile(join(tmpRoot, "projects", "large", "source.ts"), "ignored project");
      await writeFile(join(tmpRoot, "projects", "keep.md"), "negated file");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
      });
      await mirror.start();

      const manifest = storedManifest(r2);
      expect(manifest?.files[".syncignore"]?.objectKey).toBeDefined();
      expect(manifest?.files["projects/keep.md"]?.objectKey).toBeDefined();
      expect(manifest?.files["projects/large/source.ts"]).toBeUndefined();

      await writeFile(join(tmpRoot, "projects", "large", "later.ts"), "ignored later");
      await mirror.pushLocalFile("projects/large/later.ts");
      expect(storedManifest(r2)?.files["projects/large/later.ts"]).toBeUndefined();

      const remote = Buffer.from("remote");
      r2.store.set("matrixos-sync/alice/files/projects/large/remote.ts", remote);
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: "projects/large/remote.ts", hash: sha256(remote), size: remote.length, action: "update" }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });
      await settle(80);
      await expect(stat(join(tmpRoot, "projects", "large", "remote.ts"))).rejects.toThrow(/ENOENT/);
      await mirror.stop();
    });

    it("syncignore negations never override hard exclusions during directory traversal", async () => {
      await mkdir(join(tmpRoot, ".ssh"), { recursive: true });
      await mkdir(join(tmpRoot, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(tmpRoot, ".ssh", "config.md"), "ssh config");
      await writeFile(join(tmpRoot, "node_modules", "pkg", "README.md"), "dependency");
      await writeFile(join(tmpRoot, ".syncignore"), "!*.md\n!.ssh/config.md\n!node_modules/pkg/README.md\n");
      await writeFile(join(tmpRoot, "safe.md"), "safe");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
      });
      await mirror.start();

      const manifest = storedManifest(r2);
      expect(manifest?.files["safe.md"]?.objectKey).toBeDefined();
      expect(manifest?.files[".ssh/config.md"]).toBeUndefined();
      expect(manifest?.files["node_modules/pkg/README.md"]).toBeUndefined();
      await mirror.stop();
    });

    it("watches negated descendants inside ignored directories", async () => {
      await mkdir(join(tmpRoot, "projects", "large"), { recursive: true });
      await writeFile(join(tmpRoot, ".syncignore"), "projects/\n!projects/keep.md\n");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      await writeFile(join(tmpRoot, "projects", "large", "source.ts"), "ignored project");
      await writeFile(join(tmpRoot, "projects", "keep.md"), "negated file");
      await waitFor(() => storedManifest(r2)?.files["projects/keep.md"]?.objectKey !== undefined);
      expect(storedManifest(r2)?.files["projects/large/source.ts"]).toBeUndefined();
      await mirror.stop();
    });

    it("rebuilds local watches after .syncignore stops ignoring a directory", async () => {
      await mkdir(join(tmpRoot, "dynamic"), { recursive: true });
      await writeFile(join(tmpRoot, ".syncignore"), "dynamic/\n");
      await writeFile(join(tmpRoot, "dynamic", "existing.md"), "was ignored");
      let watcherReadyCount = 0;

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        onLocalWatcherReady: () => {
          watcherReadyCount++;
        },
      });
      await mirror.start();
      expect(watcherReadyCount).toBe(1);
      expect(storedManifest(r2)?.files["dynamic/existing.md"]).toBeUndefined();

      const nextPolicy = Buffer.from("# dynamic is now synced\n");
      await writeFile(join(tmpRoot, ".syncignore"), nextPolicy);
      await waitFor(() =>
        watcherReadyCount >= 2 &&
        storedManifest(r2)?.files[".syncignore"]?.hash === sha256(nextPolicy),
      );
      await waitFor(() => storedManifest(r2)?.files["dynamic/existing.md"]?.objectKey !== undefined);

      await writeFile(join(tmpRoot, "dynamic", "now.md"), "created after policy change");
      await waitFor(() => storedManifest(r2)?.files["dynamic/now.md"]?.objectKey !== undefined);
      await mirror.stop();
    });

    it("keeps a peer's newer version and preserves the stale local copy when policy re-includes a path", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      await mkdir(join(tmpRoot, "dynamic"), { recursive: true });
      await writeFile(join(tmpRoot, ".syncignore"), "dynamic/\n");
      await writeFile(join(tmpRoot, "dynamic", "doc.md"), "old gateway copy");
      await writeFile(join(tmpRoot, "dynamic", "fresh.md"), "only on gateway");
      const peerVersion = Buffer.from("newer peer copy");
      const peerKey = "matrixos-sync/alice/files/dynamic/doc.md";
      r2.store.set(peerKey, peerVersion);
      r2.store.set(
        "matrixos-sync/alice/manifest.json",
        Buffer.from(JSON.stringify({
          version: 2,
          manifestVersion: 1,
          files: {
            "dynamic/doc.md": {
              hash: sha256(peerVersion),
              size: peerVersion.length,
              mtime: Date.now(),
              peerId: "laptop-1",
              version: 1,
              objectKey: peerKey,
            },
          },
        })),
      );

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
        watchLocalChanges: false,
      });
      await mirror.start();

      await writeFile(join(tmpRoot, ".syncignore"), "# dynamic is synced now\n");
      await mirror.pushLocalFile(".syncignore");

      const manifest = storedManifest(r2);
      expect(manifest?.files["dynamic/doc.md"]?.hash).toBe(sha256(peerVersion));
      expect(manifest?.files["dynamic/fresh.md"]?.objectKey).toBeDefined();
      expect(await readFile(join(tmpRoot, "dynamic", "doc.md"), "utf8")).toBe("newer peer copy");
      const conflictPath = Object.keys(manifest?.files ?? {}).find((path) =>
        path.startsWith("dynamic/doc (conflict - gateway-alice - ")
      );
      expect(conflictPath).toBeDefined();
      expect(await readFile(join(tmpRoot, conflictPath!), "utf8")).toBe("old gateway copy");
      expect(logger.error.mock.calls.some((call) => String(call[0]).includes("conflict"))).toBe(true);
      await mirror.stop();
    });

    describe("policy re-inclusion conflicts", () => {
      const today = () => new Date().toISOString().split("T")[0]!;

      function seedRemote(files: Record<string, { body?: Buffer; hash: string; deleted?: boolean }>) {
        const entries: Record<string, unknown> = {};
        for (const [path, file] of Object.entries(files)) {
          const objectKey = `matrixos-sync/alice/files/${path}`;
          if (file.body) r2.store.set(objectKey, file.body);
          entries[path] = {
            hash: file.hash,
            size: file.deleted ? 0 : file.body?.length ?? 0,
            mtime: Date.now(),
            peerId: "laptop-1",
            version: 1,
            ...(file.deleted ? { deleted: true, deletedAt: Date.now() } : { objectKey }),
          };
        }
        r2.store.set(
          "matrixos-sync/alice/manifest.json",
          Buffer.from(JSON.stringify({ version: 2, manifestVersion: 1, files: entries })),
        );
      }

      async function startThenReinclude(nextPolicy: string) {
        const logger = { info: vi.fn(), error: vi.fn() };
        const mirror = createHomeMirror({
          r2,
          manifestDb: db,
          homeRoot: tmpRoot,
          userId: "alice",
          peerId: "gateway-alice",
          peerRegistry: registry,
          logger,
          watchLocalChanges: false,
        });
        await mirror.start();
        await writeFile(join(tmpRoot, ".syncignore"), nextPolicy);
        await mirror.pushLocalFile(".syncignore");
        return { mirror, logger };
      }

      beforeEach(async () => {
        await mkdir(join(tmpRoot, "dynamic"), { recursive: true });
        await writeFile(join(tmpRoot, ".syncignore"), "dynamic/\n");
      });

      it("applies a peer deletion when the re-included local copy is the deleted version", async () => {
        await writeFile(join(tmpRoot, "dynamic", "gone.md"), "v1");
        seedRemote({ "dynamic/gone.md": { hash: sha256(Buffer.from("v1")), deleted: true } });

        const { mirror } = await startThenReinclude("# dynamic synced\n");

        await expect(stat(join(tmpRoot, "dynamic", "gone.md"))).rejects.toThrow(/ENOENT/);
        const entry = storedManifest(r2)?.files["dynamic/gone.md"] as { deleted?: boolean } | undefined;
        expect(entry?.deleted).toBe(true);
        await mirror.stop();
      });

      it("keeps a peer deletion and publishes a locally edited copy as a conflict copy", async () => {
        await writeFile(join(tmpRoot, "dynamic", "edited.md"), "local edit");
        seedRemote({ "dynamic/edited.md": { hash: sha256(Buffer.from("v1")), deleted: true } });

        const { mirror, logger } = await startThenReinclude("# dynamic synced\n");

        await expect(stat(join(tmpRoot, "dynamic", "edited.md"))).rejects.toThrow(/ENOENT/);
        const manifest = storedManifest(r2);
        expect((manifest?.files["dynamic/edited.md"] as { deleted?: boolean } | undefined)?.deleted).toBe(true);
        const conflictPath = `dynamic/edited (conflict - gateway-alice - ${today()}).md`;
        expect(manifest?.files[conflictPath]?.objectKey).toBeDefined();
        expect(await readFile(join(tmpRoot, conflictPath), "utf8")).toBe("local edit");
        expect(logger.error.mock.calls.some((call) => String(call[0]).includes("conflict"))).toBe(true);
        await mirror.stop();
      });

      it("chooses a distinct conflict copy when the default name already holds other bytes", async () => {
        const peerVersion = Buffer.from("newer peer copy");
        await writeFile(join(tmpRoot, "dynamic", "doc.md"), "second local edit");
        const earlierCopy = `dynamic/doc (conflict - gateway-alice - ${today()}).md`;
        await writeFile(join(tmpRoot, earlierCopy), "first local edit");
        seedRemote({ "dynamic/doc.md": { body: peerVersion, hash: sha256(peerVersion) } });

        const { mirror } = await startThenReinclude("# dynamic synced\n");

        expect(await readFile(join(tmpRoot, "dynamic", "doc.md"), "utf8")).toBe("newer peer copy");
        expect(await readFile(join(tmpRoot, earlierCopy), "utf8")).toBe("first local edit");
        const manifest = storedManifest(r2);
        const secondCopy = Object.keys(manifest?.files ?? {}).find((path) =>
          path !== earlierCopy && path.startsWith("dynamic/doc (conflict - gateway-alice-")
        );
        expect(secondCopy).toBeDefined();
        expect(await readFile(join(tmpRoot, secondCopy!), "utf8")).toBe("second local edit");
        await mirror.stop();
      });

      it("rechecks the current manifest before applying a re-include deletion", async () => {
        const deletedVersion = Buffer.from("v1");
        const readded = Buffer.from("v2 re-added by peer");
        await writeFile(join(tmpRoot, "dynamic", "gone.md"), deletedVersion);
        seedRemote({ "dynamic/gone.md": { hash: sha256(deletedVersion), deleted: true } });
        const nextPolicy = Buffer.from("# dynamic synced\n");
        const scope = resolveSyncScope({ ownerId: "alice" });
        const readdedKey = "matrixos-sync/alice/files/dynamic/gone-v2.md";
        r2.store.set(readdedKey, readded);

        // Simulate a peer re-adding the file right after the refresh takes its
        // manifest snapshot (the first manifest read that already includes the
        // new policy) but before the queued deletion runs.
        let armed = true;
        const originalGetObject = r2.getObject.bind(r2);
        r2.getObject = async (key: string) => {
          const result = await originalGetObject(key);
          if (!armed || !key.includes("/manifests/")) return result;
          const raw = r2.store.get(key)!.toString("utf8");
          const parsed = JSON.parse(raw) as { files: Record<string, { hash: string }> };
          if (parsed.files[".syncignore"]?.hash !== sha256(nextPolicy)) return result;
          armed = false;
          const current = await readManifest({ r2, db }, scope);
          const next = applyCommitToManifest(
            current.manifest,
            [{ path: "dynamic/gone.md", hash: sha256(readded), size: readded.length, action: "add", objectKey: readdedKey }],
            "laptop-1",
          );
          await writeManifest({ r2, db }, scope, next, current.manifestVersion + 1);
          return { ...result, body: { async transformToByteArray() { return new Uint8Array(Buffer.from(raw)); }, async text() { return raw; } } as never };
        };

        const { mirror } = await startThenReinclude(nextPolicy.toString("utf8"));

        expect(armed).toBe(false);
        expect(await readFile(join(tmpRoot, "dynamic", "gone.md"), "utf8")).toBe("v2 re-added by peer");
        expect(storedManifest(r2)?.files["dynamic/gone.md"]?.hash).toBe(sha256(readded));
        await mirror.stop();
      });

      it("falls back to a synchronizable copy name when the owner policy ignores conflict names", async () => {
        const peerVersion = Buffer.from("newer peer copy");
        await writeFile(join(tmpRoot, "dynamic", "doc.md"), "local edit");
        seedRemote({ "dynamic/doc.md": { body: peerVersion, hash: sha256(peerVersion) } });

        const { mirror } = await startThenReinclude("*conflict*\n");

        expect(await readFile(join(tmpRoot, "dynamic", "doc.md"), "utf8")).toBe("newer peer copy");
        const manifest = storedManifest(r2);
        const copy = Object.keys(manifest?.files ?? {}).find((path) =>
          path.startsWith("dynamic/doc (gateway-alice copy ")
        );
        expect(copy).toBeDefined();
        expect(await readFile(join(tmpRoot, copy!), "utf8")).toBe("local edit");
        await mirror.stop();
      });
    });

    it("does not start a replacement watcher after stop during a policy reload", async () => {
      await mkdir(join(tmpRoot, "dynamic"), { recursive: true });
      await writeFile(join(tmpRoot, ".syncignore"), "dynamic/\n");
      let watcherReadyCount = 0;

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        onLocalWatcherReady: () => {
          watcherReadyCount++;
        },
      });
      await mirror.start();
      expect(watcherReadyCount).toBe(1);

      const nextPolicy = Buffer.from("# allow dynamic\n");
      r2.store.set("matrixos-sync/alice/files/.syncignore", nextPolicy);
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: ".syncignore", hash: sha256(nextPolicy), size: nextPolicy.length, action: "update" }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });
      await mirror.stop();
      expect(registry.getPeers("alice").some((peer) => peer.peerId === "gateway-alice")).toBe(false);

      await writeFile(join(tmpRoot, "dynamic", "after-stop.md"), "must not upload");
      await settle(800);
      expect(watcherReadyCount).toBe(1);
      expect(storedManifest(r2)?.files["dynamic/after-stop.md"]).toBeUndefined();
    });

    it("continues applying peer files after an invalid .syncignore in the same batch", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      await writeFile(join(tmpRoot, ".syncignore"), "private/\n");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
        watchLocalChanges: false,
      });
      await mirror.start();

      const invalidPolicy = Buffer.from(`${"x".repeat(600)}\n`);
      const peerNote = Buffer.from("peer note");
      const privateNote = Buffer.from("still private");
      r2.store.set("matrixos-sync/alice/files/.syncignore", invalidPolicy);
      r2.store.set("matrixos-sync/alice/files/notes/peer.md", peerNote);
      r2.store.set("matrixos-sync/alice/files/private/secret.md", privateNote);
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [
          { path: ".syncignore", hash: sha256(invalidPolicy), size: invalidPolicy.length, action: "update" },
          { path: "notes/peer.md", hash: sha256(peerNote), size: peerNote.length, action: "update" },
          { path: "private/secret.md", hash: sha256(privateNote), size: privateNote.length, action: "update" },
        ],
        peerId: "laptop-1",
        manifestVersion: 2,
      });

      await waitFor(() => logger.error.mock.calls.some((call) => String(call[0]).includes(".syncignore")));
      await waitFor(() => (logger.info.mock.calls.some((call) => String(call[0]).includes("notes/peer.md"))));
      expect((await readFile(join(tmpRoot, "notes", "peer.md"))).equals(peerNote)).toBe(true);
      expect(await readFile(join(tmpRoot, ".syncignore"), "utf8")).toBe("private/\n");
      await expect(stat(join(tmpRoot, "private", "secret.md"))).rejects.toThrow(/ENOENT/);

      await mkdir(join(tmpRoot, "private"), { recursive: true });
      await writeFile(join(tmpRoot, "private", "local.md"), "local private");
      await mirror.pushLocalFile("private/local.md");
      expect(storedManifest(r2)?.files["private/local.md"]).toBeUndefined();
      await mirror.stop();
    });

    it("cleans up orphaned temp files on startup", async () => {
      await mkdir(join(tmpRoot, "notes"), { recursive: true });
      const orphanedTmp = join(tmpRoot, "notes", "stale.md.matrixos-0f8b3c7e-1a2b-4c3d-9e8f-0123456789ab.tmp");
      const ownerTmp = join(tmpRoot, "notes", "report.12345.tmp");
      await writeFile(orphanedTmp, "stale");
      await writeFile(ownerTmp, "owner tool output");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      await expect(stat(orphanedTmp)).rejects.toThrow(/ENOENT/);
      expect(await readFile(ownerTmp, "utf8")).toBe("owner tool output");
      await mirror.stop();
    });

    it("sweeps aged orphaned temp files periodically and stops sweeping after stop", async () => {
      await mkdir(join(tmpRoot, "notes"), { recursive: true });
      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
        tempCleanupIntervalMs: 50,
        tempFileMaxAgeMs: 0,
      });
      await mirror.start();

      const ownerTmp = join(tmpRoot, "notes", "report.12345.tmp");
      await writeFile(ownerTmp, "owner tool output");
      const lateOrphan = join(tmpRoot, "notes", "late.md.matrixos-0f8b3c7e-1a2b-4c3d-9e8f-0123456789ab.tmp");
      await writeFile(lateOrphan, "orphaned after startup");
      await waitFor(() => !existsSync(lateOrphan), 5_000);
      expect(existsSync(ownerTmp)).toBe(true);

      await mirror.stop();
      const afterStop = join(tmpRoot, "notes", "after-stop.md.matrixos-0f8b3c7e-1a2b-4c3d-9e8f-0123456789ab.tmp");
      await writeFile(afterStop, "no sweeps after stop");
      await settle(300);
      expect(existsSync(afterStop)).toBe(true);
    });

    it("keeps fresh temp files during periodic sweeps so in-flight downloads survive", async () => {
      await mkdir(join(tmpRoot, "notes"), { recursive: true });
      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
        tempCleanupIntervalMs: 50,
        tempFileMaxAgeMs: 60_000,
      });
      await mirror.start();

      const inFlight = join(tmpRoot, "notes", "download.md.matrixos-0f8b3c7e-1a2b-4c3d-9e8f-0123456789ab.tmp");
      await writeFile(inFlight, "still downloading");
      await settle(300);
      expect(existsSync(inFlight)).toBe(true);
      await mirror.stop();
    });

    it("never follows symlinked temp names during cleanup", async () => {
      const outside = await mkdtemp(join(tmpdir(), "home-mirror-outside-"));
      try {
        const target = join(outside, "victim.md.matrixos-0f8b3c7e-1a2b-4c3d-9e8f-0123456789ab.tmp");
        await writeFile(target, "outside data");
        await mkdir(join(tmpRoot, "notes"), { recursive: true });
        await symlink(target, join(tmpRoot, "notes", "link.md.matrixos-0f8b3c7e-1a2b-4c3d-9e8f-0123456789ab.tmp"));

        const mirror = createHomeMirror({
          r2,
          manifestDb: db,
          homeRoot: tmpRoot,
          userId: "alice",
          peerId: "gateway-alice",
          peerRegistry: registry,
          logger: { info: () => {}, error: () => {} },
          watchLocalChanges: false,
        });
        await mirror.start();

        expect(await readFile(target, "utf8")).toBe("outside data");
        await mirror.stop();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("skips local startup push for files over the configured max size", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const putSpy = vi.spyOn(r2, "putObject");
      await writeFile(join(tmpRoot, "too-big.txt"), "12345");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
        maxPushBytes: 4,
      });
      await mirror.start();

      expect(logger.error.mock.calls.some(
        ([message]: [string]) => message.includes("skipping push for too-big.txt"),
      )).toBe(true);
      expect(putSpy).not.toHaveBeenCalled();
      expect(r2.store.has("matrixos-sync/alice/files/too-big.txt")).toBe(false);

      await mirror.stop();
    });

    it("skips symlinked files during startup push", async () => {
      const target = join(tmpRoot, "target.txt");
      const link = join(tmpRoot, "linked.txt");
      await writeFile(target, "do not upload via symlink");
      await (await import("node:fs/promises")).symlink(target, link);

      const putSpy = vi.spyOn(r2, "putObject");
      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();
      await settle(150);

      expect(putSpy).not.toHaveBeenCalledWith(
        "matrixos-sync/alice/files/linked.txt",
        expect.any(Buffer),
      );

      await mirror.stop();
    });

    it("does not re-broadcast (no infinite echo loop)", async () => {
      // When another peer commits a file, the mirror pulls it. Writing
      // that file must NOT trigger a push back to R2, otherwise every
      // sync:change would bounce once.
      const content = Buffer.from("bounce test");
      const key = `matrixos-sync/alice/files/echo.md`;
      r2.store.set(key, content);

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      const putSpy = vi.spyOn(r2, "putObject");
      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: "echo.md", hash: sha256(content), size: content.length, action: "update" }],
        peerId: "laptop-1",
        manifestVersion: 5,
      });

      // Wait longer than chokidar's stability threshold (250ms) plus buffer.
      await settle(500);

      expect(putSpy).not.toHaveBeenCalled();
      await mirror.stop();
    });

    it("skips tombstoned files during initial pull", async () => {
      const deletedContent = Buffer.from("do not resurrect");
      r2.store.set(
        "matrixos-sync/alice/files/ghost.txt",
        deletedContent,
      );
      r2.store.set(
        "matrixos-sync/alice",
        Buffer.from("unused"),
      );
      r2.store.set(
        "matrixos-sync/alice/manifest.json",
        Buffer.from(
          JSON.stringify({
            version: 2,
            files: {
              "ghost.txt": {
                hash: sha256(deletedContent),
                size: deletedContent.length,
                mtime: Date.now(),
                peerId: "laptop-1",
                version: 1,
                deleted: true,
                deletedAt: Date.now(),
              },
            },
          }),
        ),
      );

      db = {
        async getManifestMeta() {
          return {
            version: 1,
            file_count: 0,
            total_size: 0n,
            etag: '"etag"',
            updated_at: new Date(),
          };
        },
        async upsertManifestMeta() {},
        async withAdvisoryLock<T>(_userId: string, fn: (executor: unknown) => Promise<T>) {
          return fn(undefined);
        },
      } as unknown as ManifestDb;

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      await expect(stat(join(tmpRoot, "ghost.txt"))).rejects.toThrow(/ENOENT/);
      await mirror.stop();
    });

    it("retains immutable blob bytes after publishing a local deletion", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      await mirror.start();

      await writeFile(join(tmpRoot, "notes.txt"), "hello");
      await waitFor(() => Boolean(storedManifest(r2)?.files["notes.txt"]?.objectKey));
      await waitFor(() =>
        logger.info.mock.calls.some(([message]) =>
          String(message).startsWith("pushed notes.txt"),
        ),
      );

      const objectKey = storedManifest(r2)?.files["notes.txt"]?.objectKey;
      expect(objectKey).toBeDefined();
      const deleteSpy = vi.spyOn(r2, "deleteObject");
      await unlink(join(tmpRoot, "notes.txt"));
      await mirror.pushLocalDelete("notes.txt");

      expect(deleteSpy).not.toHaveBeenCalled();
      expect(r2.store.get(objectKey!)).toBeDefined();
      await mirror.stop();
    });

    it("leaves an immutable blob orphan for grace-period cleanup when a manifest write fails", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const originalPutObject = r2.putObject.bind(r2);
      vi.spyOn(r2, "putObject").mockImplementation(async (key, body) => {
        if (key.startsWith("matrixos-sync/alice/manifests/")) {
          throw new Error("manifest write failed");
        }
        return originalPutObject(key, body as Buffer);
      });

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
        watchLocalChanges: false,
      });
      await mirror.start();

      await writeFile(join(tmpRoot, "orphan.txt"), "hello");
      await expect(mirror.pushLocalFile("orphan.txt")).rejects.toThrow("manifest write failed");

      expect(
        [...r2.store.keys()].some((key) => key.startsWith("matrixos-sync/alice/objects/sha256/")),
      ).toBe(true);

      await mirror.stop();
    });

    it("leaves startup blob orphans for grace-period cleanup when manifest publication fails", async () => {
      const originalPutObject = r2.putObject.bind(r2);
      vi.spyOn(r2, "putObject").mockImplementation(async (key, body) => {
        if (key.startsWith("matrixos-sync/alice/manifests/")) {
          throw new Error("manifest write failed");
        }
        return originalPutObject(key, body as Buffer);
      });
      await writeFile(join(tmpRoot, "startup-orphan.txt"), "hello");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        logger: { info: () => {}, error: () => {} },
      });

      await expect(mirror.start()).rejects.toThrow("manifest write failed");
      expect(
        [...r2.store.keys()].some((key) => key.startsWith("matrixos-sync/alice/objects/sha256/")),
      ).toBe(true);
      await mirror.stop();
    });

    it("logs serial queue failures instead of silently swallowing them", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      db = {
        async getManifestMeta() {
          return null;
        },
        async upsertManifestMeta() {
          throw new Error("manifest db down");
        },
        async advanceManifestMeta() {
          throw new Error("manifest db down");
        },
        async withAdvisoryLock<T>(_userId: string, fn: (executor: unknown) => Promise<T>) {
          return fn(undefined);
        },
      } as unknown as ManifestDb;

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger,
      });
      await writeFile(join(tmpRoot, "queue-error.txt"), "hello");
      await expect(mirror.start()).rejects.toThrow("manifest db down");
      await waitFor(() =>
        logger.error.mock.calls.some(
          ([message]: [string]) => message.includes("serial queue task failed:"),
        ),
      );

      expect(logger.error).toHaveBeenCalledWith(
        "serial queue task failed:",
        "manifest db down",
      );
      await mirror.stop();
    });

    it("records the hash for the exact bytes uploaded", async () => {
      const filePath = join(tmpRoot, "race.txt");
      const originalPutObject = r2.putObject.bind(r2);
      vi.spyOn(r2, "putObject").mockImplementation(async (key, body) => {
        const result = await originalPutObject(key, body as Buffer);
        if (key.includes("/staging/")) {
          await writeFile(filePath, "new bytes that should not affect the uploaded hash");
        }
        return result;
      });
      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
      });
      await mirror.start();

      await writeFile(filePath, "old bytes");
      await mirror.pushLocalFile("race.txt");

      const manifest = storedManifest(r2);
      expect(manifest).toBeDefined();
      const uploaded = r2.store.get(manifest!.files["race.txt"]!.objectKey!);
      expect(uploaded).toBeDefined();
      expect(manifest!.files["race.txt"]?.hash).toBe(sha256(uploaded!));
      expect(manifest!.files["race.txt"]?.size).toBe(uploaded!.length);

      await mirror.stop();
    });

    it("uses the manifest advisory lock for local pushes and deletes", async () => {
      const lockedExecutor = { tx: "home-mirror-lock" } as unknown;
      let meta: {
        version: number;
        file_count: number;
        total_size: bigint;
        etag: string | null;
        updated_at: Date;
      } | null = null;
      const lockCalls: unknown[] = [];
      const getMetaExecutors: unknown[] = [];
      const upsertExecutors: unknown[] = [];

      db = {
        async getManifestMeta(scope: unknown, executor?: unknown) {
          lockCalls.push({ operation: "meta", scope });
          getMetaExecutors.push(executor);
          return meta;
        },
        async upsertManifestMeta(_userId: string, nextMeta, executor?: unknown) {
          upsertExecutors.push(executor);
          meta = {
            ...nextMeta,
            updated_at: new Date(),
          };
        },
        async advanceManifestMeta(_userId: string, expectedVersion, nextMeta, executor?: unknown) {
          upsertExecutors.push(executor);
          if ((meta?.version ?? 0) !== expectedVersion) return false;
          meta = {
            ...nextMeta,
            updated_at: new Date(),
          };
          return true;
        },
        async withAdvisoryLock<T>(scope: unknown, fn: (executor: unknown) => Promise<T>) {
          lockCalls.push({ operation: "lock", scope });
          return fn(lockedExecutor);
        },
      } as unknown as ManifestDb;

      const deleteSpy = vi.spyOn(r2, "deleteObject");

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
        watchLocalChanges: false,
      });
      await mirror.start();
      lockCalls.length = 0;
      getMetaExecutors.length = 0;
      upsertExecutors.length = 0;

      const filePath = join(tmpRoot, "locked.txt");
      await writeFile(filePath, "hello");
      await mirror.pushLocalFile("locked.txt");

      await unlink(filePath);
      await mirror.pushLocalDelete("locked.txt");

      expect(lockCalls.filter((entry) => (
        typeof entry === "object"
        && entry !== null
        && (entry as { operation?: string }).operation === "lock"
      ))).toEqual([
        { operation: "lock", scope: { ownerId: "alice", runtimeSlot: "primary" } },
        { operation: "lock", scope: { ownerId: "alice", runtimeSlot: "primary" } },
      ]);
      expect(getMetaExecutors.filter((entry) => entry === lockedExecutor)).toHaveLength(2);
      expect(upsertExecutors.filter((entry) => entry === lockedExecutor)).toHaveLength(2);

      await mirror.stop();
    });

    it("finalizes startup files before acquiring the short manifest lock", async () => {
      const order: string[] = [];
      await writeFile(join(tmpRoot, "preexisting.md"), "present before watcher starts");

      db = {
        async getManifestMeta() {
          return null;
        },
        async upsertManifestMeta() {
          /* no-op */
        },
        async advanceManifestMeta() {
          return true;
        },
        async withAdvisoryLock<T>(_userId: string, fn: (executor: unknown) => Promise<T>) {
          order.push("lock");
          return fn(undefined);
        },
      } as unknown as ManifestDb;

      const originalPut = r2.putObject.bind(r2);
      vi.spyOn(r2, "putObject").mockImplementation(async (...args) => {
        order.push("put");
        return originalPut(...args as Parameters<typeof originalPut>);
      });

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      expect(order.indexOf("lock")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("put")).toBeLessThan(order.indexOf("lock"));

      await mirror.stop();
    });

    it("skips startup uploads when the manifest snapshot already matches the local hash", async () => {
      const content = Buffer.from("already synced");
      const putSpy = vi.spyOn(r2, "putObject");
      r2.store.set(
        "matrixos-sync/alice/manifest.json",
        Buffer.from(JSON.stringify({
          version: 2,
          files: {
            "preexisting.md": {
              hash: sha256(content),
              size: content.length,
              mtime: Date.now(),
              peerId: "laptop-1",
              version: 1,
            },
          },
        })),
      );
      db = {
        async getManifestMeta() {
          return {
            version: 1,
            file_count: 1,
            total_size: BigInt(content.length),
            etag: '"etag"',
            updated_at: new Date(),
          };
        },
        async upsertManifestMeta() {},
        async withAdvisoryLock<T>(_userId: string, fn: (executor: unknown) => Promise<T>) {
          return fn(undefined);
        },
      } as unknown as ManifestDb;
      await writeFile(join(tmpRoot, "preexisting.md"), content);

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      expect(putSpy).not.toHaveBeenCalledWith(
        "matrixos-sync/alice/files/preexisting.md",
        expect.any(Buffer),
      );

      await mirror.stop();
    });

    it("batches startup manifest persistence into a single locked write", async () => {
      await writeFile(join(tmpRoot, "one.md"), "one");
      await writeFile(join(tmpRoot, "two.md"), "two");
      const upsertMeta = vi.fn(async () => {});
      const advanceMeta = vi.fn(async () => true);
      const lockSpy = vi.fn(async (_userId: string, fn: (executor: unknown) => Promise<unknown>) => fn(undefined));

      db = {
        async getManifestMeta() {
          return null;
        },
        upsertManifestMeta: upsertMeta,
        advanceManifestMeta: advanceMeta,
        withAdvisoryLock: lockSpy,
      } as unknown as ManifestDb;

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      expect(lockSpy).toHaveBeenCalledTimes(1);
      expect(advanceMeta).toHaveBeenCalledTimes(1);

      await mirror.stop();
    });

    it("chunks startup uploads to avoid buffering the full home directory at once", async () => {
      for (let i = 0; i < 51; i++) {
        await writeFile(join(tmpRoot, `batch-${i}.md`), `file-${i}`);
      }
      const upsertMeta = vi.fn(async () => {});
      const advanceMeta = vi.fn(async () => true);
      const lockSpy = vi.fn(async (_userId: string, fn: (executor: unknown) => Promise<unknown>) => fn(undefined));

      db = {
        async getManifestMeta() {
          return null;
        },
        upsertManifestMeta: upsertMeta,
        advanceManifestMeta: advanceMeta,
        withAdvisoryLock: lockSpy,
      } as unknown as ManifestDb;

      const mirror = createHomeMirror({
        r2,
        manifestDb: db,
        homeRoot: tmpRoot,
        userId: "alice",
        peerId: "gateway-alice",
        peerRegistry: registry,
        logger: { info: () => {}, error: () => {} },
      });
      await mirror.start();

      expect(lockSpy).toHaveBeenCalledTimes(2);
      expect(advanceMeta).toHaveBeenCalledTimes(2);

      await mirror.stop();
    });
  });
});
