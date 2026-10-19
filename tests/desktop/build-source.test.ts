import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { readBuildSource, readDesktopBuildSource } from "../../scripts/release/build-source.mjs";

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
  rmSync(`${root}-bin`, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("automatic build provenance", () => {
  it("runs legacy PR build provenance in a source-bound child while retaining the controller environment", () => {
    const controller = commit("build: reviewed workflow controller");
    const source = commit("feat: legacy preview source");
    const bin = `${root}-bin`;
    mkdirSync(bin);
    const helper = pathToFileURL(join(process.cwd(), "scripts/release/build-source.mjs")).href;
    writeFileSync(join(bin, "bun"), `#!${process.execPath}\nimport(${JSON.stringify(helper)}).then(({readBuildSource}) => console.log(JSON.stringify(readBuildSource(${JSON.stringify(root)}, process.env.GITHUB_SHA))));\n`);
    chmodSync(join(bin, "bun"), 0o755);
    const workflow = YAML.parse(readFileSync(".github/workflows/desktop-build.yml", "utf8"));
    const build = workflow.jobs.linux.steps.find((step: {name?: string}) => step.name === "Build desktop app");
    const command = build.run.trim().match(/^node --input-type=module -e "(.*)"$/s);
    expect(command, "trusted child process launcher is required for legacy PR source").not.toBeNull();
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: controller, MATRIX_DESKTOP_BUILD_SOURCE_SHA: source };
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", command![1]], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    expect(JSON.parse(output)).toEqual({ commit: source, ancestors: [controller] });
    expect(env.GITHUB_SHA).toBe(controller);
  });
  it("binds a preview to its explicit checkout source while preserving the controller identity", () => {
    const controller = commit("build: reviewed controller");
    const source = commit("feat: preview source");
    const env = { GITHUB_SHA: controller, MATRIX_DESKTOP_BUILD_SOURCE_SHA: source };
    expect(readDesktopBuildSource(root, env)).toEqual({ commit: source, ancestors: [controller] });
    expect(env.GITHUB_SHA).toBe(controller);
    expect(() => readDesktopBuildSource(root, { GITHUB_SHA: controller })).toThrow(/checkout/i);
  });
  it("preserves ordinary release provenance and rejects an invalid explicit preview source", () => {
    const source = commit("build: source");
    expect(readDesktopBuildSource(root, { GITHUB_SHA: source })?.commit).toBe(source);
    expect(readDesktopBuildSource(root, { GITHUB_SHA: source, MATRIX_DESKTOP_BUILD_SOURCE_SHA: "" })?.commit).toBe(source);
    expect(readDesktopBuildSource(root, {})?.commit).toBe(source);
    expect(() => readDesktopBuildSource(root, { GITHUB_SHA: source, MATRIX_DESKTOP_BUILD_SOURCE_SHA: "main" })).toThrow(/commit/i);
    expect(() => readDesktopBuildSource(root, { GITHUB_SHA: source, MATRIX_DESKTOP_BUILD_SOURCE_SHA: "a".repeat(40) })).toThrow(/checkout/i);
  });
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
  it("ignores only generated CI evidence while rejecting unrelated untracked source", () => {
    const artifactPaths = [
      "output/chat-dock-badge/last-state.png",
      "output/chat-subagent-activity/last-state.png",
      "output/chat-tool-details/last-state.png",
      "output/eng203/client-provenance.json",
      "output/mat524/header.png",
      "output/ci/unit-1.json",
    ];
    const artifactRules = artifactPaths.map((path) => `/${path.split("/").slice(0, 2).join("/")}/`);
    const ignore = readFileSync(".gitignore", "utf8");
    writeFileSync(join(root, ".gitignore"), ignore.split("\n").filter((line) => !artifactRules.includes(line)).join("\n"));
    git("add", ".gitignore");
    const before = commit("test: source before artifact ignores");
    for (const path of artifactPaths) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "generated evidence");
    }
    expect(git("ls-files", "--others", "--exclude-standard").split("\n").sort()).toEqual([...artifactPaths].sort());
    expect(readBuildSource(root)).toBeNull();
    expect(() => readBuildSource(root, before)).toThrow(/uncommitted/i);

    // Commit the actual repository rules; changing .gitignore itself must not
    // be mistaken for a clean checkout merely because artifacts are ignored.
    writeFileSync(join(root, ".gitignore"), ignore);
    expect(readBuildSource(root)).toBeNull();
    expect(() => readBuildSource(root, before)).toThrow(/uncommitted/i);
    git("add", ".gitignore");
    const after = commit("test: committed artifact ignores");
    expect(git("ls-files", "--others", "--exclude-standard")).toBe("");
    expect(readBuildSource(root, after)?.commit).toBe(after);

    writeFileSync(join(root, "output/unreviewed-source.ts"), "export const changed = true;");
    expect(git("ls-files", "--others", "--exclude-standard")).toBe("output/unreviewed-source.ts");
    expect(readBuildSource(root)).toBeNull();
    expect(() => readBuildSource(root, after)).toThrow(/uncommitted/i);
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
