import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";
import { readManifest } from "../../../packages/gateway/src/sync/manifest.js";
import { createFakeR2, createFakeManifestDb } from "./fixtures/home-mirror-storage.js";
const hash = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

it("reconciles owner edits made during initial publication before the watcher handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "mirror-startup-handoff-"));
  const r2 = createFakeR2(); const db = createFakeManifestDb();
  const mirror = createHomeMirror({ r2, manifestDb: db, homeRoot: root,
    userId: "synthetic-owner", peerId: "synthetic-peer", logger: { info: () => {}, error: () => {} } });
  let release!: () => void; let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const put = r2.putObject.bind(r2); let paused = false;
  vi.spyOn(r2, "putObject").mockImplementation(async (key, body, options) => {
    if (!paused && key.includes("/manifests/")) { paused = true; entered(); await pending; }
    return put(key, body, options);
  });
  let starting: Promise<void> | undefined;
  try {
    await mkdir(join(root, "system")); await writeFile(join(root, "system/soul.md"), "initial synthetic soul");
    starting = mirror.start(); await arrived;
    await writeFile(join(root, "system/soul.md"), "new owner synthetic soul"); release(); await starting;
    // Prove the real watcher and serial publication queue are active before checking the missed edit.
    await writeFile(join(root, "probe.md"), "watcher control");
    await vi.waitFor(async () => {
      const current = await readManifest({ r2, db }, "synthetic-owner");
      expect(current.manifest.files["probe.md"]?.hash).toBe(hash("watcher control"));
    }, { timeout: 3_000, interval: 25 });
    const current = await readManifest({ r2, db }, "synthetic-owner");
    expect(current.manifest.files["system/soul.md"]?.hash).toBe(hash("new owner synthetic soul"));
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("new owner synthetic soul");
  } finally { release?.(); await starting; await mirror.stop(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
}, 10_000);
