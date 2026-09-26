import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HomeMirrorState, MIRROR_STATE_DIR } from "../../../packages/gateway/src/sync/home-mirror-state.js";
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("accepted baseline persistence is atomic in memory and on disk", () => {
  const roots: string[] = []; const states: HomeMirrorState[] = [];
  afterEach(async () => { for (const state of states.splice(0)) state.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "mirror-state-atomic-")); roots.push(root);
    const dir = join(root, MIRROR_STATE_DIR); await mkdir(dir);
    const make = () => { const state = new HomeMirrorState(root, () => {}); states.push(state); return state; };
    return { root, dir, make, target: join(dir, "state.json") };
  }
  it("rejects the byte cap without changing live or restarted accepted hashes", async () => {
    const { make, target } = await fixture(); const hashes: Record<string, string> = {};
    const prefix = `system/${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(200)}/${"d".repeat(200)}/`;
    let size = Buffer.byteLength(JSON.stringify({ version: 1, hashes, conflicts: {} }));
    for (let i = 0; ; i++) {
      const path = `${prefix}${i}.md`; const entryBytes = Buffer.byteLength(JSON.stringify(path)) + Buffer.byteLength(JSON.stringify(hash("original"))) + 2;
      if (size + entryBytes >= 8 * 1024 * 1024 - 128) break;
      hashes[path] = hash("original"); size += entryBytes;
    }
    const stored = JSON.stringify({ version: 1, hashes, conflicts: {} });
    expect(Buffer.byteLength(stored)).toBeLessThan(8 * 1024 * 1024); expect(Object.keys(hashes).length).toBeLessThan(50_000);
    await writeFile(target, stored); const live = make(); await live.load();
    const path = `${prefix}new-long-valid-path.md`;
    await expect(live.remember(path, hash("new"))).rejects.toThrow("capacity");
    expect(live.hash(path)).toBeUndefined(); expect(await readFile(target, "utf8")).toBe(stored);
    const restarted = make(); await restarted.load(); expect(restarted.hash(path)).toBeUndefined();
  });
  it("rolls back live candidate changes when atomic persistence fails", async () => {
    const { make, target, dir } = await fixture(); const live = make(); await live.load(); await live.remember("note.md", hash("accepted"));
    const before = await readFile(target, "utf8"); const protectedFile = join(dir, "protected-original.json");
    await rename(target, protectedFile); await symlink(protectedFile, target);
    await expect(live.remember("note.md", hash("rejected"))).rejects.toThrow("unsafe");
    expect(live.hash("note.md")).toBe(hash("accepted"));
    expect(await readFile(protectedFile, "utf8")).toBe(before);
    await rm(target); await rename(protectedFile, target);
    const restarted = make(); await restarted.load(); expect(restarted.hash("note.md")).toBe(live.hash("note.md"));
  });
});
