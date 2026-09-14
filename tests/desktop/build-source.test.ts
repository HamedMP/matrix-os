import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBuildSource } from "../../scripts/release/build-source.mjs";

let root: string;
function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(message: string) {
  writeFileSync(join(root, "source.txt"), message);
  git("add", "source.txt");
  git("commit", "-m", message);
  return git("rev-parse", "HEAD");
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "matrix-build-source-"));
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Build fixture");
});
afterEach(() => {
  rmSync(`${root}-shallow`, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("automatic build provenance", () => {
  it("captures the actual built commit and includes earlier merged changes", () => {
    const old = commit("fix: first change (#1)");
    const current = commit("feat: paired change (#2)");
    expect(readBuildSource(root)).toEqual({ commit: current, ancestors: [old] });
  });
  it("rejects a release SHA that does not describe the checkout being built", () => {
    const old = commit("fix: first change (#1)");
    commit("feat: newer checkout (#2)");
    expect(() => readBuildSource(root, old)).toThrow(/checkout/i);
    expect(() => readBuildSource(root, "main; echo wrong")).toThrow(/commit/i);
  });
  it("does not label uncommitted code with the clean checkout's source identity", () => {
    const current = commit("fix: released source (#1)");
    writeFileSync(join(root, "source.txt"), "uncommitted change");
    expect(readBuildSource(root)).toBeNull();
    expect(() => readBuildSource(root, current)).toThrow(/uncommitted/i);
  });
  it("allows release version stamping but rejects other package modifications", () => {
    mkdirSync(join(root, "desktop"));
    const path = join(root, "desktop/package.json");
    writeFileSync(path, JSON.stringify({ name: "desktop", version: "0.1.0", scripts: { build: "build" } }));
    git("add", "desktop/package.json");
    git("commit", "-m", "build: package source");
    const current = git("rev-parse", "HEAD");
    writeFileSync(path, JSON.stringify({ name: "desktop", version: "0.1.0-canary.20260910", scripts: { build: "build" } }));
    expect(readBuildSource(root, current)?.commit).toBe(current);
    writeFileSync(path, JSON.stringify({ name: "desktop", version: "0.2.0", scripts: { build: "different" } }));
    expect(() => readBuildSource(root, current)).toThrow(/uncommitted/i);
  });
  it("does not manufacture history for shallow checkouts", () => {
    const old = commit("fix: first change (#1)");
    const current = commit("feat: latest change (#2)");
    const shallow = `${root}-shallow`;
    git("clone", "--depth=1", `file://${root}`, shallow);
    expect(readBuildSource(shallow)).toEqual({ commit: current, ancestors: [] });
    expect(readBuildSource(root)?.ancestors).toContain(old);
  });
  it("bounds ancestry even after hundreds of releases", () => {
    const history = Array.from({ length: 260 }, (_, index) => {
      const message = `change ${index}`;
      return `commit refs/heads/main\ncommitter Build fixture <fixture@example.test> ${1700000000 + index} +0000\ndata ${message.length}\n${message}\nM 100644 inline source.txt\ndata ${message.length}\n${message}\n`;
    }).join("\n");
    execFileSync("git", ["fast-import", "--quiet"], { cwd: root, input: history, timeout: 10_000, stdio: ["pipe", "ignore", "pipe"] });
    git("reset", "--hard", "HEAD");
    const built = readBuildSource(root)!;
    expect(built.commit).toBe(git("rev-parse", "HEAD"));
    expect(built.ancestors).toHaveLength(256);
    expect(built.ancestors).not.toContain(git("rev-list", "--max-count=1", "--skip=257", "HEAD"));
  });
});
