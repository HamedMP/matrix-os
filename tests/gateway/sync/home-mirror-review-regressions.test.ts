import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createHomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";
import { readManifest } from "../../../packages/gateway/src/sync/manifest.js";
import { createFakeR2, createFakeManifestDb } from "./fixtures/home-mirror-storage.js";
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("reviewed mirror startup and publication boundaries", () => {
  const roots: string[] = []; const mirrors: ReturnType<typeof createHomeMirror>[] = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const mirror of mirrors.splice(0)) await mirror.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "mirror-review-")); roots.push(root);
    const r2 = createFakeR2(); const db = createFakeManifestDb();
    const make = (homeRoot = root) => {
      const mirror = createHomeMirror({ r2, manifestDb: db, homeRoot, userId: "synthetic-owner", peerId: "synthetic-peer", watchLocalChanges: false, logger: { info: () => {}, error: () => {} } });
      mirrors.push(mirror); return mirror;
    };
    await writeFile(join(root, "note.md"), "accepted original"); const first = make(); await first.start(); await first.stop();
    return { root, r2, db, make, remote: () => readManifest({ r2, db }, "synthetic-owner") };
  }
  it("does not restore an accepted file deleted while the gateway was stopped", async () => {
    const { root, make, remote } = await fixture(); await rm(join(root, "note.md"));
    await make().start();
    await expect(readFile(join(root, "note.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await remote()).manifest.files["note.md"].deleted).toBe(true);
  });
  it("preserves a stopped owner deletion and divergent remote original as a conflict", async () => {
    const { root, make, remote } = await fixture(); const otherRoot = await mkdtemp(join(tmpdir(), "mirror-review-remote-")); roots.push(otherRoot);
    const other = make(otherRoot); await other.start(); await writeFile(join(otherRoot, "note.md"), "remote divergent original"); await other.pushLocalFile("note.md"); await other.stop();
    await rm(join(root, "note.md")); await make().start();
    await expect(readFile(join(root, "note.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await remote()).manifest.files["note.md"].hash).toBe(hash("remote divergent original"));
    expect((await remote()).manifest.files["note.md"].deleted).not.toBe(true);
    const state = JSON.parse(await readFile(join(root, ".matrix-home-mirror/state.json"), "utf8"));
    expect(state.conflicts["note.md"].localDeleted).toBe(true);
    expect(await readFile(join(root, ".matrix-home-mirror", state.conflicts["note.md"].artifact), "utf8")).toBe("remote divergent original");
  });
  it("still restores an unknown absent path without treating absence as an owner deletion", async () => {
    const { root, make, remote } = await fixture(); await rm(join(root, ".matrix-home-mirror/state.json")); await rm(join(root, "note.md")); await make().start();
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("accepted original");
    expect((await remote()).manifest.files["note.md"].deleted).not.toBe(true);
  });
  it.each([
    ["single", "lock"], ["batch", "lock"], ["single", "generation"], ["batch", "generation"],
  ])("does not accept captured stale bytes for %s publication paused at %s", async (kind, seam) => {
    const { root, make, db, r2, remote } = await fixture(); const active = make();
    if (kind === "single") await active.start();
    await writeFile(join(root, "note.md"), "captured stale edit");
    let release!: () => void; let arrived!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { arrived = resolve; });
    const lock = db.withAdvisoryLock.bind(db); let paused = false;
    if (seam === "lock") vi.spyOn(db, "withAdvisoryLock").mockImplementation(async (scope, callback) => {
      if (!paused) { paused = true; arrived(); await pending; } return lock(scope, callback);
    });
    else {
      const put = r2.putObject.bind(r2);
      vi.spyOn(r2, "putObject").mockImplementation(async (key, body, options) => {
        if (!paused && key.includes("/manifests/")) { paused = true; arrived(); await pending; }
        return put(key, body, options);
      });
    }
    const operation = kind === "single" ? active.pushLocalFile("note.md") : active.start();
    try { await entered; await writeFile(join(root, "note.md"), "newer owner edit"); }
    finally { release(); }
    await operation;
    expect((await remote()).manifest.files["note.md"].hash).toBe(hash("accepted original"));
    const state = JSON.parse(await readFile(join(root, ".matrix-home-mirror/state.json"), "utf8"));
    expect(state.hashes["note.md"]).toBe(hash("accepted original"));
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("newer owner edit");
  });
  it("preflights projected baseline capacity before accepting a startup publication", async () => {
    const { root, make, remote } = await fixture();
    const target = join(root, ".matrix-home-mirror/state.json");
    const state = JSON.parse(await readFile(target, "utf8"));
    const prefix = `system/${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(200)}/${"d".repeat(200)}/`;
    let size = Buffer.byteLength(JSON.stringify(state));
    for (let i = 0; ; i++) {
      const path = `${prefix}${i}.md`; const bytes = Buffer.byteLength(JSON.stringify(path)) + Buffer.byteLength(JSON.stringify(hash("accepted original"))) + 2;
      if (size + bytes >= 8 * 1024 * 1024 - 128) break;
      state.hashes[path] = hash("accepted original"); size += bytes;
    }
    const stored = JSON.stringify(state); await writeFile(target, stored);
    const path = `${prefix}new-long-valid-path.md`;
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), "new original");
    const before = await remote();
    await expect(make().start()).rejects.toThrow();
    const after = await remote();
    expect(after.manifestVersion).toBe(before.manifestVersion);
    expect(after.manifest.files[path]).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe(stored);
    expect(await readFile(join(root, path), "utf8")).toBe("new original");
  });
  it.each(["pull", "conflict"])("bounds a stalled iterator body after headers during normal %s", async kind => {
    const { root, make, r2 } = await fixture(); const otherRoot = await mkdtemp(join(tmpdir(), "mirror-review-remote-")); roots.push(otherRoot);
    const other = make(otherRoot); await other.start(); await writeFile(join(otherRoot, "note.md"), "remote edit"); await other.pushLocalFile("note.md"); await other.stop();
    if (kind === "conflict") await writeFile(join(root, "note.md"), "local divergent edit");
    let release!: () => void; let arrived!: () => void; let returned = false;
    const pending = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { arrived = resolve; });
    const deadline = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const get = r2.getObject.bind(r2);
    vi.spyOn(r2, "getObject").mockImplementation(async (key, options) => {
      if (key.includes("/objects/sha256/")) return { body: {
        [Symbol.asyncIterator]: () => ({
          next: async () => { arrived(); await pending; return { done: true, value: undefined }; },
          return: async () => { returned = true; return { done: true, value: undefined }; },
        }),
      } as unknown as ReadableStream };
      return get(key, options);
    });
    const starting = make().start().then(() => "unexpected-success", () => "bounded-failure");
    try {
      await entered; deadline.abort(new Error("synthetic read deadline"));
      const result = await Promise.race([starting, new Promise(resolve => setTimeout(() => resolve("stalled"), 100))]);
      expect(result).toBe("bounded-failure"); expect(returned).toBe(true);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(kind === "conflict" ? "local divergent edit" : "accepted original");
    } finally { release(); await starting; }
  });
});
