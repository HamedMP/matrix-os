import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveWithinHome } from "../../packages/gateway/src/path-security.js";

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
});
