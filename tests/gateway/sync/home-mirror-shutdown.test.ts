import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";
import { createFakeR2, createFakeManifestDb } from "./fixtures/home-mirror-storage.js";

describe("mirror shutdown cancels requests and bodies already issued before stop", () => {
  it.each(["request", "body"])("bounds a stalled pre-stop %s and prevents late accepted publication", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "mirror-shutdown-"));
    const r2 = createFakeR2(); const db = createFakeManifestDb();
    const mirror = createHomeMirror({ r2, manifestDb: db, homeRoot: root,
      userId: "synthetic-owner", peerId: "synthetic-gateway", watchLocalChanges: false,
      logger: { info: () => {}, error: () => {} } });
    let release!: () => void; let arrived!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    let observedSignal: AbortSignal | undefined; let paused = false;
    const get = r2.getObject.bind(r2);
    try {
      await writeFile(join(root, "note.md"), "initial bytes"); await mirror.start();
      const before = await db.getManifestMeta("synthetic-owner");
      vi.spyOn(r2, "getObject").mockImplementation(async (key, options) => {
        const original = await get(key, options);
        if (!paused && key.includes("/staging/")) {
          paused = true; observedSignal = options?.signal; arrived();
          if (kind === "request") await pending;
          else return { ...original, body: { transformToByteArray: async () => {
            await pending;
            return new Uint8Array(Buffer.from("edited bytes"));
          } } as unknown as ReadableStream };
        }
        return original;
      });
      await writeFile(join(root, "note.md"), "edited bytes");
      const pushing = mirror.pushLocalFile("note.md").then(() => "done", () => "aborted");
      await entered;
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      const started = Date.now(); await mirror.stop();
      expect(Date.now() - started).toBeLessThan(10_500);
      expect(observedSignal?.aborted).toBe(true);
      release(); await pushing;
      expect((await db.getManifestMeta("synthetic-owner"))?.version).toBe(before?.version);
    } finally { release?.(); await mirror.stop(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
  }, 15_000);
});
