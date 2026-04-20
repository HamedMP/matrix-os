import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";
import {
  createPeerRegistry,
  type PeerRegistry,
} from "../../../packages/gateway/src/sync/ws-events.js";
import type { R2Client } from "../../../packages/gateway/src/sync/r2-client.js";
import type { ManifestDb } from "../../../packages/gateway/src/sync/manifest.js";

function sha256(buf: Buffer): string {
  const { createHash } = require("node:crypto");
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
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
    async putObject(key: string, body: Buffer) {
      store.set(key, body);
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
  return {
    async getManifestMeta() {
      return null;
    },
    async upsertManifestMeta() {
      /* no-op */
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

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
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

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "home-mirror-test-"));
    r2 = createFakeR2();
    db = createFakeManifestDb();
    registry = createPeerRegistry();
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
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

    it("refuses traversal paths on remote writes", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const outsidePath = join(tmpRoot, "..", "escaped-write.txt");
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
        files: [{ path: "../escaped-write.txt", hash: sha256(Buffer.from("evil")), size: 4, action: "update" }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });

      await settle(80);

      await expect(stat(outsidePath)).rejects.toThrow(/ENOENT/);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("remote-change failed for ../escaped-write.txt:"),
        expect.stringMatching(/invalid/i),
      );

      await mirror.stop();
    });

    it("refuses traversal paths on remote deletes", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const outsidePath = join(tmpRoot, "..", "escaped-delete.txt");
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
      await mirror.start();

      registry.broadcastChange("alice", "laptop-1", {
        type: "sync:change",
        files: [{ path: "../escaped-delete.txt", hash: "sha256:" + "0".repeat(64), size: 0, action: "delete" }],
        peerId: "laptop-1",
        manifestVersion: 2,
      });

      await settle(80);

      const remaining = await readFile(outsidePath, "utf8");
      expect(remaining).toBe("keep me");
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("remote-change failed for ../escaped-delete.txt:"),
        expect.stringMatching(/invalid/i),
      );

      await mirror.stop();
    });

    it("ignores broadcasts for ignored paths (e.g. node_modules)", async () => {
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
        files: [{ path: "node_modules/evil.js", hash: "sha256:deadbeef", size: 10, action: "update" }],
        peerId: "laptop-1",
        manifestVersion: 4,
      });
      await settle(40);

      // The file must not have been downloaded -- there's no R2 entry for it
      // and no attempt to fetch.
      await expect(stat(join(tmpRoot, "node_modules/evil.js"))).rejects.toThrow(/ENOENT/);
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
      // broadcast. Chokidar + awaitWriteFinish (250ms) + macOS fsevents
      // startup latency needs ~1.5s in CI.
      await writeFile(join(tmpRoot, "new.md"), "container wrote this");
      await settle(1500);

      const syncChanges = laptopSends.filter((s) => s.includes('"sync:change"'));
      expect(syncChanges.length).toBeGreaterThan(0);
      expect(syncChanges.some((s) => s.includes("new.md"))).toBe(true);

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

    it("logs blob-delete failures instead of swallowing them", async () => {
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
      await waitFor(() => r2.store.has("matrixos-sync/alice/files/notes.txt"));

      const deleteSpy = vi.spyOn(r2, "deleteObject").mockRejectedValueOnce(new Error("r2 unavailable"));
      await unlink(join(tmpRoot, "notes.txt"));
      await waitFor(() => deleteSpy.mock.calls.length > 0);

      expect(deleteSpy).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("delete blob failed for notes.txt:"),
        "r2 unavailable",
      );
      await mirror.stop();
    });

    it("records the hash for the exact bytes uploaded", async () => {
      const gate = deferred<void>();
      let getMetaCalls = 0;
      db = {
        async getManifestMeta() {
          getMetaCalls++;
          if (getMetaCalls === 2) {
            await gate.promise;
          }
          return null;
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

      const filePath = join(tmpRoot, "race.txt");
      await writeFile(filePath, "old bytes");
      await waitFor(() => getMetaCalls > 1);
      await writeFile(filePath, "new bytes that should win");
      gate.resolve();

      await waitFor(() => r2.store.has("matrixos-sync/alice/manifest.json"));

      const uploaded = r2.store.get("matrixos-sync/alice/files/race.txt");
      const manifestBuf = r2.store.get("matrixos-sync/alice/manifest.json");
      expect(uploaded).toBeDefined();
      expect(manifestBuf).toBeDefined();

      const manifest = JSON.parse(manifestBuf!.toString("utf8")) as {
        files: Record<string, { hash: string; size: number }>;
      };
      expect(manifest.files["race.txt"]?.hash).toBe(sha256(uploaded!));
      expect(manifest.files["race.txt"]?.size).toBe(uploaded!.length);

      await mirror.stop();
    });
  });
});
