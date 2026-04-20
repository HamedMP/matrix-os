import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
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
    async withAdvisoryLock<T>(_userId: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  } as unknown as ManifestDb;
}

async function settle(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
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
  });
});
