import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";
import { ensureHome } from "../../../packages/kernel/src/boot.js";
import { createFakeR2, createFakeManifestDb } from "./fixtures/home-mirror-storage.js";


describe("home mirror restart preserves local boot state", () => {
  const roots: string[] = [];
  const mirrors: ReturnType<typeof createHomeMirror>[] = [];
  afterEach(async () => {
    for (const mirror of mirrors.splice(0)) await mirror.stop();
    vi.restoreAllMocks(); vi.useRealTimers();
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
    return { root, make, r2, manifestDb };
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
  it("flushes an immediate owner edit on graceful stop before the watcher debounce", async () => {
    const { root, make } = await fixture("system/soul.md", "original soul");
    const active = make();
    await active.start();
    await writeFile(join(root, "system/soul.md"), "last moment owner edit");
    await active.stop();
    await make().start();
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("last moment owner edit");
  });
  it("pulls a remote-only edit when the local file still matches its durable baseline", async () => {
    const { root, make, r2, manifestDb } = await fixture("system/soul.md", "original soul");
    const otherRoot = await mkdtemp(join(tmpdir(), "matrix-other-peer-")); roots.push(otherRoot);
    const other = createHomeMirror({ r2, manifestDb, homeRoot: otherRoot,
      userId: "synthetic-owner", peerId: "other", watchLocalChanges: false,
      logger: { info: () => {}, error: () => {} } }); mirrors.push(other);
    await other.start();
    await writeFile(join(otherRoot, "system/soul.md"), "remote edit");
    await other.pushLocalFile("system/soul.md"); await other.stop();
    await make().start();
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("remote edit");
  });
  it("preserves both originals on divergent edits without publishing over the remote", async () => {
    const { root, make, r2, manifestDb } = await fixture("system/soul.md", "original soul");
    const otherRoot = await mkdtemp(join(tmpdir(), "matrix-other-peer-")); roots.push(otherRoot);
    const other = createHomeMirror({ r2, manifestDb, homeRoot: otherRoot,
      userId: "synthetic-owner", peerId: "other", watchLocalChanges: false,
      logger: { info: () => {}, error: () => {} } }); mirrors.push(other);
    await other.start();
    await writeFile(join(otherRoot, "system/soul.md"), "remote divergent edit");
    await other.pushLocalFile("system/soul.md"); await other.stop();
    await writeFile(join(root, "system/soul.md"), "local divergent edit");
    await make().start();
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("local divergent edit");
    const state = JSON.parse(await readFile(join(root, ".matrix-home-mirror", "state.json"), "utf8"));
    const conflict = state.conflicts["system/soul.md"];
    expect(await readFile(join(root, ".matrix-home-mirror", conflict.artifact), "utf8")).toBe("remote divergent edit");
    await other.start();
    expect(await readFile(join(otherRoot, "system/soul.md"), "utf8")).toBe("remote divergent edit");
  });

  it.each(["missing", "corrupt"])("preserves both originals when the durable baseline is %s", async (kind) => {
    const { root, make } = await fixture("system/soul.md", "remote original");
    const statePath = join(root, ".matrix-home-mirror", "state.json");
    if (kind === "missing") await rm(statePath); else await writeFile(statePath, "not valid JSON");
    await writeFile(join(root, "system/soul.md"), "local original");
    await make().start();
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("local original");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(await readFile(join(root, ".matrix-home-mirror", state.conflicts["system/soul.md"].artifact), "utf8")).toBe("remote original");
  });

  it("preserves an owner edit made while a remote-only download is pending", async () => {
    const { root, make, r2, manifestDb } = await fixture("system/soul.md", "original soul");
    const otherRoot = await mkdtemp(join(tmpdir(), "matrix-other-peer-")); roots.push(otherRoot);
    const other = createHomeMirror({ r2, manifestDb, homeRoot: otherRoot, userId: "synthetic-owner", peerId: "other", watchLocalChanges: false, logger: { info: () => {}, error: () => {} } }); mirrors.push(other);
    await other.start(); await writeFile(join(otherRoot, "system/soul.md"), "remote edit"); await other.pushLocalFile("system/soul.md"); await other.stop();
    let release!: () => void; let arrived!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const get = r2.getObject.bind(r2); let paused = false;
    vi.spyOn(r2, "getObject").mockImplementation(async (key, options) => {
      const result = await get(key, options);
      if (!paused && key.includes("/objects/sha256/")) { paused = true; arrived(); await pending; }
      return result;
    });
    const starting = make().start(); await entered;
    await writeFile(join(root, "system/soul.md"), "owner edit during download"); release(); await starting;
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("owner edit during download");
    const state = JSON.parse(await readFile(join(root, ".matrix-home-mirror/state.json"), "utf8"));
    expect(await readFile(join(root, ".matrix-home-mirror", state.conflicts["system/soul.md"].artifact), "utf8")).toBe("remote edit");
  });

  it("returns from shutdown after its deadline when the manifest lock stalls, without late publication", async () => {
    const { root, make, manifestDb } = await fixture("system/soul.md", "original soul");
    const active = make(); await active.start();
    const before = await manifestDb.getManifestMeta("synthetic-owner");
    let release!: () => void; let arrived!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const lock = manifestDb.withAdvisoryLock.bind(manifestDb); let paused = false;
    vi.spyOn(manifestDb, "withAdvisoryLock").mockImplementation(async (scope, callback) => {
      if (!paused) { paused = true; arrived(); await pending; }
      return lock(scope, callback);
    });
    await writeFile(join(root, "system/soul.md"), "late unpublished edit");
    const pushing = active.pushLocalFile("system/soul.md");
    // Attach a handler immediately; the late aborted callback must reject normally.
    const settled = pushing.then(() => "done", () => "aborted");
    await entered;
    const stopping = active.stop();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const returned = await Promise.race([stopping.then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 10_500); })]);
      expect(returned).toBe(true);
    } finally { if (timeout) clearTimeout(timeout); release(); await settled; await stopping; }
    expect((await manifestDb.getManifestMeta("synthetic-owner"))?.version).toBe(before?.version);
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("late unpublished edit");
  }, 15_000);

});
