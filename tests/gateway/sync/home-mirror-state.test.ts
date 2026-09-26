import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HomeMirrorState, MIRROR_STATE_DIR } from "../../../packages/gateway/src/sync/home-mirror-state.js";
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
describe("bounded home mirror baseline and conflict storage", () => {
  const roots: string[] = []; const states: HomeMirrorState[] = [];
  afterEach(async () => { for (const state of states.splice(0)) state.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "mirror-state-")); roots.push(root);
    const make = () => { const state = new HomeMirrorState(root, () => {}); states.push(state); return state; };
    return { root, make, dir: join(root, MIRROR_STATE_DIR) };
  }
  it("persists a validated baseline across processes", async () => {
    const { make } = await fixture(); const first = make(); await first.load();
    await first.remember("system/soul.md", hash("original")); first.close();
    const second = make(); await second.load(); expect(second.hash("system/soul.md")).toBe(hash("original"));
  });
  it.each(["../outside", "/outside", "safe/../../outside", "safe\\outside", ".matrix-home-mirror/state.json"])("rejects unsafe tracked path %s", async (path) => {
    const { make } = await fixture(); const state = make(); await state.load();
    await expect(state.remember(path, hash("original"))).rejects.toThrow();
  });
  it("never follows a symlinked state directory or modifies its target", async () => {
    const { root, make, dir } = await fixture(); const target = join(root, "protected");
    await mkdir(target); await writeFile(join(target, "state.json"), "protected owner bytes");
    await symlink(target, dir); await expect(make().load()).rejects.toThrow();
    expect(await readFile(join(target, "state.json"), "utf8")).toBe("protected owner bytes");
  });
  it("never follows a symlinked baseline file", async () => {
    const { root, make, dir } = await fixture(); await mkdir(dir);
    const target = join(root, "protected"); await writeFile(target, "protected owner bytes"); await symlink(target, join(dir, "state.json"));
    await expect(make().load()).rejects.toThrow(); expect(await readFile(target, "utf8")).toBe("protected owner bytes");
  });
  it("rejects a replaced parent home after loading without writing through its symlink", async () => {
    const { root, make } = await fixture(); const state = make(); await state.load();
    const saved = `${root}-original`; const target = `${root}-replacement`; roots.push(saved, target);
    await rename(root, saved); await mkdir(target); await symlink(target, root);
    await expect(state.remember("system/soul.md", hash("original"))).rejects.toThrow("unsafe");
    expect(await readdir(target)).toEqual([]);
  });
  it("rejects a replaced state directory after loading", async () => {
    const { make, dir } = await fixture(); const state = make(); await state.load();
    await rename(dir, `${dir}-original`); await mkdir(dir);
    await expect(state.remember("system/soul.md", hash("original"))).rejects.toThrow("unsafe");
    expect(await readdir(dir)).toEqual([]);
  });
  it("rejects exhausted archive capacity without deleting any original artifact", async () => {
    const { make, dir } = await fixture(); const state = make(); await state.load();
    for (let i = 0; i < 100; i++) await writeFile(join(dir, `conflict-${i.toString(16).padStart(64, "0")}.bin`), "owner conflict original");
    await expect(state.preserve("system/soul.md", hash("local"), hash("remote"), Buffer.from("remote"))).rejects.toThrow("capacity");
    expect((await readdir(dir)).filter((name) => name.startsWith("conflict-")).length).toBe(100);
    expect(await readFile(join(dir, `conflict-${"0".repeat(64)}.bin`), "utf8")).toBe("owner conflict original");
  });
  it("cleans only stale owned temporary regular files, retaining symlinks and conflict originals", async () => {
    const { root, make, dir } = await fixture(); await mkdir(dir);
    const temp = join(dir, "state-00000000-0000-0000-0000-000000000000.tmp");
    await writeFile(temp, "abandoned temp"); await utimes(temp, 0, 0);
    const target = join(root, "owner-original"); await writeFile(target, "protected bytes");
    const linked = join(dir, "state-11111111-1111-1111-1111-111111111111.tmp"); await symlink(target, linked);
    const conflict = join(dir, `conflict-${"a".repeat(64)}.bin`); await writeFile(conflict, "conflict original"); await utimes(conflict, 0, 0);
    await make().load(); expect(await readdir(dir)).not.toContain(temp.split("/").at(-1));
    expect(await readFile(linked, "utf8")).toBe("protected bytes"); expect(await readFile(conflict, "utf8")).toBe("conflict original");
  });
});
