import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile, renameFile } from "../../packages/gateway/src/file-ops.js";
import { isNativeFileCapabilityTarget } from "../../packages/gateway/src/file-management/native-file-capability.js";

const describeNative = isNativeFileCapabilityTarget() ? describe : describe.skip;

describeNative("Desktop typed file mutations", () => {
  let testDir: string;
  const requestId = "a9d9d1d8-8e5d-45d0-8d17-2c85f4e19a11";

  beforeEach(() => {
    testDir = join(tmpdir(), `desktop-file-ops-test-${Date.now()}`);
    mkdirSync(join(testDir, "projects"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates an exclusive typed file and returns its normalized path and capabilities", async () => {
    const result = await createFile(testDir, {
      requestId,
      parentDirectory: "projects",
      name: "notes.md",
      kind: "file",
    });

    expect(result).toEqual({
      ok: true,
      path: "projects/notes.md",
      resultCode: "created",
      capabilities: { canRename: true, canMove: true, canTrash: true },
    });
    expect(readFileSync(join(testDir, "projects", "notes.md"), "utf8")).toBe("");
  });

  it("renames a typed file without allowing an occupied target", async () => {
    writeFileSync(join(testDir, "projects", "old.md"), "content");
    const result = await renameFile(testDir, {
      requestId,
      path: "projects/old.md",
      name: "new.md",
    });

    expect(result).toEqual({
      ok: true,
      path: "projects/new.md",
      resultCode: "renamed",
      capabilities: { canRename: true, canMove: true, canTrash: true },
    });
    expect(existsSync(join(testDir, "projects", "old.md"))).toBe(false);
    expect(readFileSync(join(testDir, "projects", "new.md"), "utf8")).toBe("content");
  });

  it("rejects an occupied typed rename target without overwriting it", async () => {
    writeFileSync(join(testDir, "projects", "old.md"), "source");
    writeFileSync(join(testDir, "projects", "occupied.md"), "destination");
    const result = await renameFile(testDir, {
      requestId,
      path: "projects/old.md",
      name: "occupied.md",
    });

    expect(result).toEqual({ ok: false, errorCode: "destination_conflict" });
    expect(readFileSync(join(testDir, "projects", "old.md"), "utf8")).toBe("source");
    expect(readFileSync(join(testDir, "projects", "occupied.md"), "utf8")).toBe("destination");
  });

  it("renames an ordinary owner file in the home root", async () => {
    writeFileSync(join(testDir, "root.md"), "root");
    const result = await renameFile(testDir, {
      requestId,
      path: "root.md",
      name: "renamed.md",
    });

    expect(result).toMatchObject({ ok: true, path: "renamed.md", resultCode: "renamed" });
    expect(readFileSync(join(testDir, "renamed.md"), "utf8")).toBe("root");
  });

  it("creates an ordinary owner file in the home root", async () => {
    const result = await createFile(testDir, {
      requestId,
      parentDirectory: "",
      name: "root.md",
      kind: "file",
    });

    expect(result).toMatchObject({ ok: true, path: "root.md", resultCode: "created" });
    expect(readFileSync(join(testDir, "root.md"), "utf8")).toBe("");
  });

  it.each([".ssh", ".trash", "system", "agents"])(
    "rejects typed create targeting protected root %s",
    async (name) => {
      const result = await createFile(testDir, {
        requestId,
        parentDirectory: "",
        name,
        kind: "directory",
      });

      expect(result).toEqual({ ok: false, errorCode: "protected" });
      expect(existsSync(join(testDir, name))).toBe(false);
    },
  );

  it.each([".ssh", ".trash", "system", "agents"])(
    "rejects typed rename targeting protected root %s",
    async (name) => {
      writeFileSync(join(testDir, "source.md"), "source");
      const result = await renameFile(testDir, { requestId, path: "source.md", name });

      expect(result).toEqual({ ok: false, errorCode: "protected" });
      expect(readFileSync(join(testDir, "source.md"), "utf8")).toBe("source");
      expect(existsSync(join(testDir, name))).toBe(false);
    },
  );

  it("lets only one concurrent typed rename claimant create a destination", async () => {
    writeFileSync(join(testDir, "first.md"), "first");
    writeFileSync(join(testDir, "second.md"), "second");
    const results = await Promise.all([
      renameFile(testDir, { requestId, path: "first.md", name: "claimed.md" }),
      renameFile(testDir, { requestId, path: "second.md", name: "claimed.md" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.errorCode === "destination_conflict")).toHaveLength(1);
    const targetContent = readFileSync(join(testDir, "claimed.md"), "utf8");
    const losingSource = targetContent === "first" ? "second.md" : "first.md";
    expect(readFileSync(join(testDir, losingSource), "utf8")).toBe(
      losingSource === "first.md" ? "first" : "second",
    );
  });

  it("rejects a typed directory rename to itself before copying", async () => {
    mkdirSync(join(testDir, "projects", "folder"));
    const result = await renameFile(testDir, {
      requestId,
      path: "projects/folder",
      name: "folder",
    });

    expect(result).toEqual({ ok: false, errorCode: "invalid_path" });
    expect(existsSync(join(testDir, "projects", "folder"))).toBe(true);
  });
});
