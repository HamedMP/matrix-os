import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";
import { ensureHome } from "../../../packages/kernel/src/boot.js";
import type { R2Client } from "../../../packages/gateway/src/sync/r2-client.js";
import type { ManifestDb } from "../../../packages/gateway/src/sync/manifest.js";

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


describe("home mirror restart preserves local boot state", () => {
  const roots: string[] = [];
  const mirrors: ReturnType<typeof createHomeMirror>[] = [];
  afterEach(async () => {
    for (const mirror of mirrors.splice(0)) await mirror.stop();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture(path: string, original: string) {
    const root = await mkdtemp(join(tmpdir(), "matrix-mirror-restart-"));
    roots.push(root);
    await mkdir(join(root, "system"));
    await writeFile(join(root, path), original);
    const r2 = createFakeR2();
    const manifestDb = createFakeManifestDb();
    const make = () => {
      const mirror = createHomeMirror({ r2, manifestDb, homeRoot: root,
        userId: "synthetic-owner", peerId: "synthetic-gateway", watchLocalChanges: false,
        logger: { info: () => {}, error: () => {} } });
      mirrors.push(mirror);
      return mirror;
    };
    const first = make();
    await first.start();
    await first.stop();
    return { root, make };
  }
  it("does not replace an owner soul edited after its last persisted mirror snapshot", async () => {
    const { root, make } = await fixture("system/soul.md", "original soul");
    await writeFile(join(root, "system/soul.md"), "owner customized soul");
    ensureHome(root);
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("owner customized soul");
    await make().start();
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("owner customized soul");
  });
  it("does not roll back the version marker updated by actual boot", async () => {
    const { root, make } = await fixture(".matrix-version", "0.3.0\n");
    ensureHome(root);
    const version = await readFile(join(root, ".matrix-version"), "utf8");
    expect(version.trim()).toBe("0.4.0");
    await make().start();
    expect(await readFile(join(root, ".matrix-version"), "utf8")).toBe(version);
  });
});
