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
  const diagnostics: string[] = [];
  const mirror = createHomeMirror({ r2, manifestDb: db, homeRoot: root,
    userId: "synthetic-owner", peerId: "synthetic-peer", logger: {
      info: message => { if (diagnostics.length < 40) diagnostics.push(message.split(" ").slice(0, 3).join(" ")); },
      error: () => { if (diagnostics.length < 40) diagnostics.push("mirror_error"); },
    } });
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
    }, { timeout: 3_000, interval: 25 }).catch(error => {
      console.error("synthetic watcher diagnostic", diagnostics); throw error;
    });
    const current = await readManifest({ r2, db }, "synthetic-owner");
    expect(current.manifest.files["system/soul.md"]?.hash).toBe(hash("new owner synthetic soul"));
    expect(await readFile(join(root, "system/soul.md"), "utf8")).toBe("new owner synthetic soul");
  } finally { release?.(); await starting; await mirror.stop(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
}, 10_000);

it("retains explicit one-shot publication when local watching is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "mirror-startup-disabled-"));
  const r2 = createFakeR2(); const db = createFakeManifestDb();
  const mirror = createHomeMirror({ r2, manifestDb: db, homeRoot: root, userId: "synthetic-owner", peerId: "synthetic-peer", watchLocalChanges: false,
    logger: { info: () => {}, error: () => {} } });
  try {
    await writeFile(join(root, "note.md"), "original"); await mirror.start();
    await writeFile(join(root, "note.md"), "manual edit");
    expect((await readManifest({ r2, db }, "synthetic-owner")).manifest.files["note.md"].hash).toBe(hash("original"));
    await mirror.pushLocalFile("note.md");
    expect((await readManifest({ r2, db }, "synthetic-owner")).manifest.files["note.md"].hash).toBe(hash("manual edit"));
  } finally { await mirror.stop(); await rm(root, { recursive: true, force: true }); }
});

it.each(["owner-edit", "stop"])("preserves %s during the watcher-ready catch-up", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "mirror-startup-catchup-"));
  const r2 = createFakeR2(); const db = createFakeManifestDb();
  const mirror = createHomeMirror({ r2, manifestDb: db, homeRoot: root, userId: "synthetic-owner", peerId: "synthetic-peer",
    logger: { info: () => {}, error: () => {} } });
  let releaseFirst!: () => void; let releaseSecond!: () => void; let firstArrived!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  const entered = new Promise<void>(resolve => { firstArrived = resolve; });
  let count = 0; let secondEntered = false;
  const put = r2.putObject.bind(r2);
  vi.spyOn(r2, "putObject").mockImplementation(async (key, body, options) => {
    if (key.includes("/manifests/")) {
      count++;
      if (count === 1) { firstArrived(); await first; }
      else if (count === 2) { secondEntered = true; await second; }
    }
    return put(key, body, options);
  });
  let starting: Promise<void> | undefined;
  try {
    await writeFile(join(root, "note.md"), "original"); starting = mirror.start(); await entered;
    await writeFile(join(root, "note.md"), "first owner edit"); releaseFirst();
    await vi.waitFor(() => expect(secondEntered).toBe(true), { timeout: 2_000, interval: 25 });
    if (kind === "stop") {
      const timeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, ms, ...args) =>
        timeout(callback, ms === 10_000 ? 10 : ms, ...args)) as typeof setTimeout);
      await mirror.stop(); releaseSecond(); await starting;
      expect((await readManifest({ r2, db }, "synthetic-owner")).manifest.files["note.md"]).toBeUndefined();
    } else {
      await writeFile(join(root, "note.md"), "newest owner edit"); releaseSecond(); await starting;
      await vi.waitFor(async () => expect((await readManifest({ r2, db }, "synthetic-owner")).manifest.files["note.md"]?.hash).toBe(hash("newest owner edit")), { timeout: 3_000, interval: 25 });
    }
    expect(await readFile(join(root, "note.md"), "utf8")).toBe(kind === "stop" ? "first owner edit" : "newest owner edit");
  } finally { releaseFirst?.(); releaseSecond?.(); await starting; await mirror.stop(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
}, 10_000);
