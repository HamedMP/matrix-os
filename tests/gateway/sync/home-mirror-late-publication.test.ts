import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";
import { createFakeR2, createFakeManifestDb } from "./fixtures/home-mirror-storage.js";

const seam = vi.hoisted(() => ({ armed: false, entered: () => {}, wait: Promise.resolve() }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, realpath: async (...args: Parameters<typeof fs.realpath>) => {
    if (seam.armed) { seam.armed = false; seam.entered(); await seam.wait; }
    return fs.realpath(...args);
  } };
});

describe("mirror late publication after the shutdown deadline", () => {
  afterEach(() => { seam.armed = false; vi.restoreAllMocks(); });
  it.each(["single-generation", "single-rehash", "delete-rehash", "startup-batch-rehash"])(
    "rejects a late %s acceptance through the public lifecycle", async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "mirror-late-cas-"));
      const r2 = createFakeR2(); const db = createFakeManifestDb();
      const make = () => createHomeMirror({ r2, manifestDb: db, homeRoot: root,
        userId: "synthetic-owner", peerId: "synthetic-peer", watchLocalChanges: false,
        logger: { info: () => {}, error: () => {} } });
      let release!: () => void; let entered!: () => void;
      seam.wait = new Promise<void>(resolve => { release = resolve; });
      const arrived = new Promise<void>(resolve => { entered = resolve; }); seam.entered = entered;
      let active = make(); let operation: Promise<unknown> | undefined;
      try {
        await writeFile(join(root, "note.md"), "accepted original"); await active.start();
        if (kind === "startup-batch-rehash") { await active.stop(); active = make(); }
        const before = await db.getManifestMeta("synthetic-owner");
        const baseline = await readFile(join(root, ".matrix-home-mirror/state.json"), "utf8");
        if (kind === "delete-rehash") await rm(join(root, "note.md"));
        else await writeFile(join(root, "note.md"), "new owner bytes");
        const put = r2.putObject.bind(r2); let intercepted = false;
        vi.spyOn(r2, "putObject").mockImplementation(async (key, body, options) => {
          if (!intercepted && key.includes("/manifests/")) {
            intercepted = true;
            if (kind === "single-generation") { entered(); await seam.wait; }
            else seam.armed = true;
          }
          return put(key, body, options);
        });
        operation = (kind === "startup-batch-rehash" ? active.start() : kind === "delete-rehash"
          ? active.pushLocalDelete("note.md") : active.pushLocalFile("note.md")).then(() => "settled", () => "rejected");
        await arrived;
        // Exercise the real stop deadline, accelerated only in this test's clock.
        const timeout = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, ms, ...args) =>
          timeout(callback, ms === 10_000 ? 10 : ms, ...args)) as typeof setTimeout);
        await active.stop(); release(); await operation;
        expect((await db.getManifestMeta("synthetic-owner"))?.version).toBe(before?.version);
        expect(await readFile(join(root, ".matrix-home-mirror/state.json"), "utf8")).toBe(baseline);
        if (kind === "delete-rehash") await expect(readFile(join(root, "note.md"))).rejects.toMatchObject({ code: "ENOENT" });
        else expect(await readFile(join(root, "note.md"), "utf8")).toBe("new owner bytes");
      } finally { release?.(); await operation; await active.stop(); await rm(root, { recursive: true, force: true }); }
    }, 15_000,
  );
});
