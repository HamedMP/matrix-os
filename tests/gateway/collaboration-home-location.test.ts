import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHomeLocationResolver } from "../../packages/gateway/src/collaboration/home-location.js";

// User outcome: the write fence knows where a linked home really is, without
// a disk lookup on every write, and notices when the link moves.
describe("home location resolver", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "matrix-home-location-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("follows a linked home, reuses the answer within the TTL and resolves again after it", async () => {
    const first = await mkdtemp(join(dir, "first-"));
    const second = await mkdtemp(join(dir, "second-"));
    const link = join(dir, "home");
    await symlink(first, link);
    let now = 0;
    const resolveHome = createHomeLocationResolver({ ttlMs: 1_000, now: () => now });
    expect(await resolveHome(link)).toBe(await realpath(first));
    await rm(link);
    await symlink(second, link);
    now = 999;
    expect(await resolveHome(link)).toBe(await realpath(first));
    now = 1_000;
    expect(await resolveHome(link)).toBe(await realpath(second));
  });

  it("does not keep a failed lookup, so the next request tries again", async () => {
    const target = join(dir, "target");
    const link = join(dir, "home");
    await symlink(target, link);
    const resolveHome = createHomeLocationResolver({ now: () => 0 });
    await expect(resolveHome(link)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(target);
    expect(await resolveHome(link)).toBe(await realpath(target));
  });

  it("keeps at most maxHomes entries", async () => {
    const homes = await Promise.all([0, 1, 2].map((index) => mkdtemp(join(dir, `h${index}-`))));
    const real = await Promise.all(homes.map((home) => realpath(home)));
    const resolveHome = createHomeLocationResolver({ maxHomes: 2, now: () => 0 });
    for (const [index, home] of homes.entries()) expect(await resolveHome(home)).toBe(real[index]);
    // The oldest entry was dropped: removing it now makes its lookup fail instead of answering from the cache.
    await rm(homes[0]!, { recursive: true });
    await expect(resolveHome(homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    // The newest entry is still cached and answers without a lookup.
    await rm(homes[2]!, { recursive: true });
    expect(await resolveHome(homes[2]!)).toBe(real[2]);
  });
});
