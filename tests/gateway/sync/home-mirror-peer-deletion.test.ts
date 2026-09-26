import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createHomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";
import { createPeerRegistry } from "../../../packages/gateway/src/sync/ws-events.js";
import { readManifest } from "../../../packages/gateway/src/sync/manifest.js";
import { createFakeR2, createFakeManifestDb } from "./fixtures/home-mirror-storage.js";
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("peer broadcasts reconcile owner absence without reentering the serial queue", () => {
  const roots: string[] = []; const mirrors: ReturnType<typeof createHomeMirror>[] = [];
  afterEach(async () => { await Promise.all(mirrors.splice(0).map(mirror => mirror.stop())); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  it.each(["accepted-deletion", "divergent-deletion", "unknown-absence"])("finishes %s and subsequent queued publication before shutdown", async kind => {
    const root = await mkdtemp(join(tmpdir(), "mirror-peer-delete-")); roots.push(root);
    const otherRoot = await mkdtemp(join(tmpdir(), "mirror-peer-other-")); roots.push(otherRoot);
    const r2 = createFakeR2(); const db = createFakeManifestDb(); const registry = createPeerRegistry();
    const make = (homeRoot: string, peerId: string, subscribe = false) => {
      const mirror = createHomeMirror({ homeRoot, peerId, userId: "synthetic-owner", r2, manifestDb: db, ...(subscribe ? { peerRegistry: registry } : {}), watchLocalChanges: false, logger: { info: () => {}, error: () => {} } });
      mirrors.push(mirror); return mirror;
    };
    await writeFile(join(root, "note.md"), "accepted original");
    const active = make(root, "active-owner", true); await active.start();
    const other = make(otherRoot, "other-peer"); await other.start();
    const path = kind === "unknown-absence" ? "new.md" : "note.md";
    const content = kind === "accepted-deletion" ? "accepted original" : "remote original";
    if (kind !== "unknown-absence") await rm(join(root, path));
    if (kind !== "accepted-deletion") { await writeFile(join(otherRoot, path), content); await other.pushLocalFile(path); }
    registry.broadcastChange("synthetic-owner", "other-peer", { type: "sync:change", peerId: "other-peer", files: [{ path, hash: hash(content), size: Buffer.byteLength(content), action: "update" }] });
    await writeFile(join(root, "subsequent.md"), "valid subsequent owner data");
    const push = active.pushLocalFile("subsequent.md").then(() => "completed", () => "failed");
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<string>(resolve => { timer = setTimeout(() => resolve("queue-stalled"), 1_000); });
    try { expect(await Promise.race([push, deadline])).toBe("completed"); }
    finally { clearTimeout(timer); }
    const { manifest } = await readManifest({ r2, db }, "synthetic-owner");
    expect(manifest.files["subsequent.md"].hash).toBe(hash("valid subsequent owner data"));
    if (kind === "unknown-absence") {
      expect(await readFile(join(root, path), "utf8")).toBe(content);
      expect(manifest.files[path].deleted).not.toBe(true);
    } else {
      await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
      if (kind === "accepted-deletion") expect(manifest.files[path].deleted).toBe(true);
      else {
        expect(manifest.files[path].hash).toBe(hash(content)); expect(manifest.files[path].deleted).not.toBe(true);
        const state = JSON.parse(await readFile(join(root, ".matrix-home-mirror/state.json"), "utf8"));
        expect(state.conflicts[path].localDeleted).toBe(true);
        expect(await readFile(join(root, ".matrix-home-mirror", state.conflicts[path].artifact), "utf8")).toBe(content);
      }
    }
  });
});
