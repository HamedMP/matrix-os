import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getMissingFileFallback } from "../../packages/gateway/src/file-fallbacks.js";
import {
  isDeniedFileApiPath,
  resolveExistingFileApiPath,
  resolveWithinHome,
  resolveWritableFileApiPath,
} from "../../packages/gateway/src/path-security.js";
import { listDirectory } from "../../packages/gateway/src/files-tree.js";

describe("/files/* path containment", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "files-test-")));
    mkdirSync(join(homePath, "modules"), { recursive: true });
    writeFileSync(join(homePath, "modules/hello.html"), "<h1>hi</h1>");
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("allows paths within home directory", () => {
    const result = resolveWithinHome(homePath, "modules/hello.html");
    expect(result).toBe(join(homePath, "modules/hello.html"));
  });

  it("blocks ../ traversal to parent", () => {
    expect(resolveWithinHome(homePath, "../etc/passwd")).toBeNull();
  });

  it("blocks ../../ deep traversal", () => {
    expect(resolveWithinHome(homePath, "../../etc/shadow")).toBeNull();
  });

  it("blocks encoded traversal via path segments", () => {
    expect(resolveWithinHome(homePath, "modules/../../etc/passwd")).toBeNull();
  });

  it("allows nested paths within home", () => {
    const result = resolveWithinHome(homePath, "modules/../modules/hello.html");
    expect(result).toBe(join(homePath, "modules/hello.html"));
  });

  it("blocks absolute path escape", () => {
    expect(resolveWithinHome(homePath, "/etc/passwd")).toBeNull();
  });

  it("blocks sibling paths that share the same string prefix", () => {
    const homeName = homePath.split("/").pop() ?? "home";
    expect(resolveWithinHome(homePath, `../${homeName}-evil/secret.txt`)).toBeNull();
  });

  it("denies browser profile paths from file API helpers", async () => {
    mkdirSync(join(homePath, "data/browser-profiles/default"), { recursive: true });
    writeFileSync(join(homePath, "data/browser-profiles/default/Cookies"), "session");

    expect(isDeniedFileApiPath(homePath, "data/browser-profiles/default/Cookies")).toBe(true);
    expect(resolveExistingFileApiPath(homePath, "data/browser-profiles/default/Cookies")).toBeNull();
    await expect(listDirectory(homePath, "data/browser-profiles")).resolves.toBeNull();
  });

  it("rejects readable paths that are symlinks out of home", () => {
    const outside = resolve(mkdtempSync(join(tmpdir(), "files-outside-")));
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(homePath, "modules/linked.txt"));

    try {
      expect(resolveExistingFileApiPath(homePath, "modules/linked.txt")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects writable paths whose parent traverses a symlink", () => {
    const outside = resolve(mkdtempSync(join(tmpdir(), "files-outside-")));
    symlinkSync(outside, join(homePath, "modules/link-dir"));

    try {
      expect(resolveWritableFileApiPath(homePath, "modules/link-dir/owned.txt")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("serves an empty module registry fallback when modules.json is missing", () => {
    expect(getMissingFileFallback("system/modules.json")).toEqual({
      body: "[]",
      contentType: "application/json",
    });
    expect(getMissingFileFallback("system/theme.json")).toBeNull();
  });
});
