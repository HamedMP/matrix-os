import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { UnsafeOwnerSystemDirError, withPinnedSystemDir } from "../../packages/gateway/src/get-started/owner-system-dir.js";
import { writeUtf8FileAtomic } from "../../packages/gateway/src/shell/atomic-write.js";

describe("withPinnedSystemDir", () => {
  let root: string;
  let homePath: string;

  beforeEach(async () => {
    root = resolve(await mkdtemp(join(tmpdir(), "owner-system-dir-")));
    homePath = join(root, "home");
    await mkdir(join(homePath, "system"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads, writes atomically and creates exclusively inside the owner's system directory", async () => {
    await writeFile(join(homePath, "system", "a.json"), "{}");
    const result = await withPinnedSystemDir(homePath, async (dir) => {
      const before = await dir.readFile("a.json", 1024);
      await dir.writeAtomic("a.json", '{"b":1}\n', 0o644);
      const created = await dir.createExclusive("marker.json", "{}\n");
      const again = await dir.createExclusive("marker.json", "{}\n");
      return { before, created, again, missing: await dir.readFile("missing.json", 1024) };
    });
    expect(result).toEqual({ before: "{}", created: true, again: false, missing: null });
    expect(await readFile(join(homePath, "system", "a.json"), "utf-8")).toBe('{"b":1}\n');
  });

  it("reads a file right at the size cap and refuses one byte more", async () => {
    await writeFile(join(homePath, "system", "edge.json"), "x".repeat(1024));
    expect(await withPinnedSystemDir(homePath, (dir) => dir.readFile("edge.json", 1024))).toBe("x".repeat(1024));
    await writeFile(join(homePath, "system", "edge.json"), "x".repeat(1025));
    await expect(withPinnedSystemDir(homePath, (dir) => dir.readFile("edge.json", 1024))).rejects.toBeInstanceOf(UnsafeOwnerSystemDirError);
  });

  it("publishes a staged eligibility file without overwriting another process's completion receipt", async () => {
    const target = join(homePath, "system/get-started.json");
    const receipt = '{"version":1,"status":"skipped","skippedAt":"2026-10-29T10:00:00.000Z"}';
    await expect(writeUtf8FileAtomic(target, '{"version":1,"status":"pending"}', 0o644, {
      exclusive: true,
      beforeCommit: async () => { await writeFile(target, receipt, { flag: "wx" }); },
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe(receipt);
    expect(await readdir(join(homePath, "system"))).toEqual(["get-started.json"]);
  });

  it("returns null when the home has no system directory", async () => {
    await rm(join(homePath, "system"), { recursive: true });
    expect(await withPinnedSystemDir(homePath, async () => "used")).toBeNull();
  });

  it("refuses a symlinked system directory and oversized or non-regular files", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(homePath, "system", "big.json"), "x".repeat(2048));
    await mkdir(join(homePath, "system", "dir.json"));
    await expect(withPinnedSystemDir(homePath, (dir) => dir.readFile("big.json", 1024))).rejects.toBeInstanceOf(UnsafeOwnerSystemDirError);
    await expect(withPinnedSystemDir(homePath, (dir) => dir.readFile("dir.json", 1024))).rejects.toBeInstanceOf(UnsafeOwnerSystemDirError);
    await rename(join(homePath, "system"), join(homePath, "system-real"));
    await symlink(outside, join(homePath, "system"));
    await expect(withPinnedSystemDir(homePath, async () => "used")).rejects.toBeInstanceOf(UnsafeOwnerSystemDirError);
  });

  it("never commits into a directory that replaced the pinned one", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await expect(withPinnedSystemDir(homePath, async (dir) => {
      await rename(join(homePath, "system"), join(homePath, "system-moved"));
      await symlink(outside, join(homePath, "system"));
      await dir.writeAtomic("state.json", "{}\n", 0o644);
    })).rejects.toBeInstanceOf(UnsafeOwnerSystemDirError);
    expect(existsSync(join(outside, "state.json"))).toBe(false);
    expect(existsSync(join(homePath, "system-moved", "state.json"))).toBe(false);
  });
});
