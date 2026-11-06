import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CollaborativeBuildSnapshotError,
  ImmutableCollaborativeBuildStore,
} from "../../../packages/gateway/src/app-runtime/build-cache.js";

let root: string;
let buildRoot: string;
let storeRoot: string;
let now: number;
let stores: ImmutableCollaborativeBuildStore[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "collaborative-build-"));
  buildRoot = join(root, "dist");
  storeRoot = join(root, "store");
  now = Date.parse("2026-11-05T10:00:00.000Z");
  stores = [];
  await mkdir(join(buildRoot, "assets"), { recursive: true });
  await writeFile(join(buildRoot, "index.html"), "<main>tracker</main>");
  await writeFile(join(buildRoot, "assets", "app.js"), "console.log('v1')");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.map((store) => store.close()));
  await rm(root, { recursive: true, force: true });
});

function createStore() {
  const store = new ImmutableCollaborativeBuildStore({
    rootDir: storeRoot,
    maxSnapshots: 4,
    retentionMs: 1_000,
    cleanupIntervalMs: 60_000,
    now: () => now,
  });
  stores.push(store);
  return store;
}

describe("immutable collaborative build snapshots", () => {
  it("captures deterministic immutable bytes and a content digest", async () => {
    const store = createStore();
    const first = await store.capture({ buildRoot, buildId: "a".repeat(64) });
    const second = await store.capture({ buildRoot, buildId: "a".repeat(64) });
    expect(second).toEqual(first);
    expect(first.assetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(first.artifactPath, "index.html"), "utf8")).toBe("<main>tracker</main>");

    await writeFile(join(buildRoot, "index.html"), "<main>changed</main>");
    expect(await readFile(join(first.artifactPath, "index.html"), "utf8")).toBe("<main>tracker</main>");
    await expect(store.capture({ buildRoot, buildId: "a".repeat(64) }))
      .rejects.toMatchObject({ code: "build_id_collision" });
  });

  it("persists references across an ordinary store restart", async () => {
    const firstStore = createStore();
    const snapshot = await firstStore.capture({ buildRoot, buildId: "b".repeat(64) });
    await firstStore.retain(snapshot.buildId, "readiness:one");
    await firstStore.close();

    const restarted = createStore();
    now += 10_000;
    expect(await restarted.cleanup()).toEqual({ removed: 0 });
    expect(await restarted.resolve(snapshot.buildId)).toMatchObject({ assetDigest: snapshot.assetDigest });
    await restarted.release(snapshot.buildId, "readiness:one");
    now += 2_000;
    expect(await restarted.cleanup()).toEqual({ removed: 1 });
    expect(await restarted.resolve(snapshot.buildId)).toBeNull();
  });

  it("retains referenced snapshots and evicts unreferenced snapshots by TTL and cap", async () => {
    const store = createStore();
    const retained = await store.capture({ buildRoot, buildId: "c".repeat(64) });
    await store.retain(retained.buildId, "binding:one");
    await writeFile(join(buildRoot, "index.html"), "two");
    const unreferenced = await store.capture({ buildRoot, buildId: "d".repeat(64) });
    now += 2_000;
    expect(await store.cleanup()).toEqual({ removed: 1 });
    expect(await store.resolve(retained.buildId)).not.toBeNull();
    expect(await store.resolve(unreferenced.buildId)).toBeNull();
  });

  it("serializes concurrent reference changes with cleanup", async () => {
    const store = createStore();
    const snapshot = await store.capture({ buildRoot, buildId: "1".repeat(64) });

    await Promise.all([
      store.retain(snapshot.buildId, "binding:one"),
      store.retain(snapshot.buildId, "binding:two"),
    ]);
    expect((await (store as any).readMetadata(snapshot.buildId)).references.sort())
      .toEqual(["binding:one", "binding:two"]);

    now += 2_000;
    const retained = store.retain(snapshot.buildId, "binding:three");
    const cleanup = store.cleanup();
    await retained;
    expect(await cleanup).toEqual({ removed: 0 });
    expect(await store.resolve(snapshot.buildId)).not.toBeNull();
  });

  it("recovers a capture whose metadata write was interrupted and sweeps orphan objects", async () => {
    const store = createStore();
    const writeMetadata = vi.spyOn(store as any, "writeMetadata").mockRejectedValueOnce(new Error("interrupted"));
    await expect(store.capture({ buildRoot, buildId: "2".repeat(64) })).rejects.toThrow("interrupted");
    writeMetadata.mockRestore();

    await expect(store.capture({ buildRoot, buildId: "2".repeat(64) }))
      .resolves.toMatchObject({ buildId: "2".repeat(64) });

    const orphanId = "3".repeat(64);
    await mkdir(join(storeRoot, "objects", orphanId), { recursive: true });
    await writeFile(join(storeRoot, "objects", orphanId, "index.html"), "orphan");
    expect(await store.cleanup()).toEqual({ removed: 1 });
    await expect(readFile(join(storeRoot, "objects", orphanId, "index.html"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinks and never follows attacker-named links during cleanup", async () => {
    const store = createStore();
    await symlink(join(root, "outside"), join(buildRoot, "escape"));
    await expect(store.capture({ buildRoot, buildId: "e".repeat(64) }))
      .rejects.toBeInstanceOf(CollaborativeBuildSnapshotError);

    await mkdir(join(storeRoot, "objects"), { recursive: true });
    await writeFile(join(root, "outside"), "keep");
    await symlink(join(root, "outside"), join(storeRoot, "objects", "f".repeat(64)));
    now += 2_000;
    await store.cleanup();
    expect(await readFile(join(root, "outside"), "utf8")).toBe("keep");
  });
});
