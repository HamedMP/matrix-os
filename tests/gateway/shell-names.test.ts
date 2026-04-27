import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateLayoutName,
  validateProfileName,
  validateSessionName,
  resolveShellCwd,
} from "../../packages/gateway/src/shell/names.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-names-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell name and path validation", () => {
  it("accepts safe session, layout, and profile slugs", () => {
    expect(validateSessionName("main")).toBe("main");
    expect(validateLayoutName("dev-workspace-1")).toBe("dev-workspace-1");
    expect(validateProfileName("local")).toBe("local");
  });

  it("rejects unsafe identifiers", () => {
    for (const value of ["Main", "-main", "main_", "../main", "a".repeat(65)]) {
      expect(() => validateSessionName(value)).toThrow("Invalid request");
      expect(() => validateLayoutName(value)).toThrow("Invalid request");
      expect(() => validateProfileName(value)).toThrow("Invalid request");
    }
  });

  it("resolves cwd inside the owner home", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "projects", "app"), { recursive: true });
    await mkdir(join(root, "work"), { recursive: true });

    await expect(resolveShellCwd("~/projects/app", root)).resolves.toBe(
      await realpath(join(root, "projects", "app")),
    );
    await expect(resolveShellCwd("work", root)).resolves.toBe(await realpath(join(root, "work")));
  });

  it("rejects cwd outside the owner home", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(join(tmpdir(), "matrix-shell-outside-"));
    roots.push(outside);

    await expect(resolveShellCwd(outside, root)).rejects.toThrow("Invalid cwd");
    await expect(resolveShellCwd("../bob", root)).rejects.toThrow("Invalid cwd");
  });

  it("rejects cwd symlinks that escape the owner home", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(join(tmpdir(), "matrix-shell-outside-"));
    roots.push(outside);
    await symlink(outside, join(root, "escape"));

    await expect(resolveShellCwd("escape", root)).rejects.toThrow("Invalid cwd");
  });
});
