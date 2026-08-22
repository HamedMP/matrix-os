import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile, renameFile } from "../../packages/gateway/src/file-ops.js";

describe("Desktop typed file mutations", () => {
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

  it("creates and reports a contained file whose name begins with two dots", async () => {
    const result = await createFile(testDir, {
      requestId,
      parentDirectory: "projects",
      name: "..notes.md",
      kind: "file",
    });

    expect(result).toMatchObject({
      ok: true,
      path: "projects/..notes.md",
      resultCode: "created",
    });
    expect(readFileSync(join(testDir, "projects", "..notes.md"), "utf8")).toBe("");
  });

  it("creates and renames a contained top-level file whose name begins with two dots", async () => {
    const created = await createFile(testDir, {
      requestId,
      parentDirectory: "",
      name: "..notes.md",
      kind: "file",
    });

    expect(created).toMatchObject({
      ok: true,
      path: "..notes.md",
      resultCode: "created",
    });

    const renamed = await renameFile(testDir, {
      requestId: "b9d9d1d8-8e5d-45d0-8d17-2c85f4e19a11",
      path: "..notes.md",
      name: "..renamed.md",
    });

    expect(renamed).toMatchObject({
      ok: true,
      path: "..renamed.md",
      resultCode: "renamed",
    });
    expect(existsSync(join(testDir, "..notes.md"))).toBe(false);
    expect(readFileSync(join(testDir, "..renamed.md"), "utf8")).toBe("");
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

  it("renames and reports a contained file whose name begins with two dots", async () => {
    writeFileSync(join(testDir, "projects", "old.md"), "content");
    const result = await renameFile(testDir, {
      requestId,
      path: "projects/old.md",
      name: "..new.md",
    });

    expect(result).toMatchObject({
      ok: true,
      path: "projects/..new.md",
      resultCode: "renamed",
    });
    expect(existsSync(join(testDir, "projects", "old.md"))).toBe(false);
    expect(readFileSync(join(testDir, "projects", "..new.md"), "utf8")).toBe("content");
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

  it("keeps a recoverable source when typed rename cleanup fails", async () => {
    writeFileSync(join(testDir, "source.md"), "source");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await renameFile(
      testDir,
      { requestId, path: "source.md", name: "destination.md" },
      { removeSource: async () => { throw new Error("simulated cleanup failure"); } },
    );
    warn.mockRestore();

    expect(result).toMatchObject({
      ok: false,
      path: "destination.md",
      resultCode: "cleanup_failed",
      errorCode: "cleanup_failed",
      recoveryPath: expect.stringMatching(/^\.matrix-rename-recovery-/),
    });
    expect(readFileSync(join(testDir, result.recoveryPath!), "utf8")).toBe("source");
    expect(readFileSync(join(testDir, "destination.md"), "utf8")).toBe("source");
  });

  it("preserves a modified typed rename source instead of cleaning it up", async () => {
    writeFileSync(join(testDir, "source.md"), "source");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await renameFile(
      testDir,
      { requestId, path: "source.md", name: "destination.md" },
      { beforeCleanup: async (source) => { writeFileSync(source, "replacement"); } },
    );
    warn.mockRestore();

    expect(result).toMatchObject({
      ok: false,
      path: "destination.md",
      resultCode: "cleanup_failed",
      errorCode: "cleanup_failed",
    });
    expect(readFileSync(join(testDir, "source.md"), "utf8")).toBe("replacement");
    expect(readFileSync(join(testDir, "destination.md"), "utf8")).toBe("source");
  });

  it("preserves a typed directory when a descendant changes after copy", async () => {
    mkdirSync(join(testDir, "projects", "folder"));
    writeFileSync(join(testDir, "projects", "folder", "child.md"), "source");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await renameFile(
      testDir,
      { requestId, path: "projects/folder", name: "renamed" },
      { beforeCleanup: async (source) => { writeFileSync(join(source, "child.md"), "replacement"); } },
    );
    warn.mockRestore();

    expect(result).toMatchObject({
      ok: false,
      path: "projects/renamed",
      resultCode: "cleanup_failed",
      errorCode: "cleanup_failed",
    });
    expect(readFileSync(join(testDir, "projects", "folder", "child.md"), "utf8")).toBe("replacement");
    expect(readFileSync(join(testDir, "projects", "renamed", "child.md"), "utf8")).toBe("source");
  });

  it("quarantines a typed replacement that appears after cleanup verification", async () => {
    writeFileSync(join(testDir, "projects", "source.md"), "source");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await renameFile(
      testDir,
      { requestId, path: "projects/source.md", name: "destination.md" },
      {
        beforeDetach: async (source) => {
          rmSync(source);
          writeFileSync(source, "replacement");
        },
      },
    );
    warn.mockRestore();

    expect(result).toMatchObject({
      ok: false,
      path: "projects/destination.md",
      resultCode: "cleanup_failed",
      errorCode: "cleanup_failed",
      recoveryPath: expect.stringMatching(/^projects\/\.matrix-rename-recovery-/),
    });
    expect(existsSync(join(testDir, "projects", "source.md"))).toBe(false);
    expect(readFileSync(join(testDir, result.recoveryPath!), "utf8")).toBe("replacement");
    expect(readFileSync(join(testDir, "projects", "destination.md"), "utf8")).toBe("source");
  });

  it("surfaces a typed partial directory destination without removing its source", async () => {
    mkdirSync(join(testDir, "projects", "folder", "nested"), { recursive: true });
    writeFileSync(join(testDir, "projects", "folder", "nested", "file.md"), "source");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await renameFile(
      testDir,
      { requestId, path: "projects/folder", name: "renamed" },
      { afterDirectoryClaim: async (target) => { mkdirSync(join(target, "nested")); } },
    );
    warn.mockRestore();

    expect(result).toEqual({
      ok: false,
      errorCode: "failed",
      partialPath: "projects/renamed",
    });
    expect(readFileSync(join(testDir, "projects", "folder", "nested", "file.md"), "utf8")).toBe("source");
    expect(existsSync(join(testDir, "projects", "renamed"))).toBe(true);
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
