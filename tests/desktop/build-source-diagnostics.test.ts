import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBuildSource } from "../../scripts/release/build-source.mjs";

let root: string;
let commit: string;
const message = "Release checkout has uncommitted source changes";
const git = (...args: string[]) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", timeout: 10_000, stdio: "pipe",
});
function failure() {
  try { readBuildSource(root, commit); } catch (error) { return error as Error; }
  throw new Error("Expected the release guard to reject the fixture");
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "matrix-source-diagnostic-"));
  git("init", "-b", "main");
  git("config", "user.name", "Build fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "source.txt"), "committed source");
  git("add", ".");
  git("commit", "-m", "synthetic source");
  commit = git("rev-parse", "HEAD").trim();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("release checkout failure diagnostics", () => {
  it("classifies tracked and untracked paths without reading contents or mutating changes", () => {
    writeFileSync(join(root, "source.txt"), "PRIVATE CONTENT NEVER DIAGNOSED");
    writeFileSync(join(root, "new-source.ts"), "ANOTHER PRIVATE CONTENT");
    const before = git("status", "--porcelain=v1", "-z");
    const error = failure();
    expect(error.message).toBe(message);
    expect(error.cause).toEqual({
      code: "release_checkout_dirty",
      trackedPaths: ["source.txt"], untrackedPaths: ["new-source.ts"],
      trackedCount: 1, untrackedCount: 1, truncatedPathCount: 0,
    });
    expect(JSON.stringify(error.cause)).not.toContain(root);
    expect(JSON.stringify(error.cause)).not.toContain("PRIVATE CONTENT");
    expect(git("status", "--porcelain=v1", "-z")).toBe(before);
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("PRIVATE CONTENT NEVER DIAGNOSED");
    expect(readBuildSource(root)).toBeNull();
  });

  it("preserves whitespace and escapes hostile filename controls as printable metadata", () => {
    const path = " leading\n\u001b[31m\t\u202e\u061c\u2060\u{e0001}-source.ts";
    writeFileSync(join(root, path), "never print this content");
    const diagnostic = failure().cause;
    expect(diagnostic).toMatchObject({
      trackedPaths: [], untrackedPaths: [" leading\\n\\u001b[31m\\t\\u202e\\u061c\\u2060\\udb40\\udc01-source.ts"],
      trackedCount: 0, untrackedCount: 1, truncatedPathCount: 0,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/u);
  });

  it.each(["tracked", "untracked"] as const)("caps %s path count and escaped lengths while retaining total counts", (kind) => {
    for (let index = 0; index < 40; index++) {
      const directory = `dir-${String(index).padStart(2, "0")}-${"x".repeat(180)}`;
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, `${"y".repeat(180)}.ts`), "fixture");
    }
    if (kind === "tracked") {
      git("add", "."); git("commit", "-m", "bounded tracked paths");
      commit = git("rev-parse", "HEAD").trim();
      for (const path of git("ls-files", "-z").split("\0").filter(path => path.startsWith("dir-"))) {
        writeFileSync(join(root, path), "changed fixture");
      }
    }
    const diagnostic = failure().cause as {
      untrackedPaths: string[]; trackedPaths: string[];
      untrackedCount: number; trackedCount: number; truncatedPathCount: number;
    };
    expect(diagnostic[`${kind}Count`]).toBe(40);
    expect(diagnostic[kind === "tracked" ? "untrackedCount" : "trackedCount"]).toBe(0);
    expect(diagnostic[`${kind}Paths`]).toHaveLength(16);
    expect(diagnostic[`${kind}Paths`].every(path => path.length <= 240)).toBe(true);
    expect(diagnostic.truncatedPathCount).toBe(16);
    expect(JSON.stringify(diagnostic).length).toBeLessThan(9_000);
    const names = kind === "tracked" ? git("diff", "--name-only", "-z", "HEAD") : git("ls-files", "--others", "--exclude-standard", "-z");
    expect(names.split("\0").filter(Boolean)).toHaveLength(40);
  });

  it("caps the escaped representation of a short control-heavy filename", () => {
    writeFileSync(join(root, `${"\t".repeat(125)}.ts`), "fixture");
    expect(failure().cause).toMatchObject({
      untrackedCount: 1, truncatedPathCount: 1,
      untrackedPaths: [expect.stringMatching(/\.\.\.\[truncated\]$/)],
    });
    const { untrackedPaths } = failure().cause as { untrackedPaths: string[] };
    expect(untrackedPaths[0].length).toBeLessThanOrEqual(240);
  });

  it("retains path metadata through the actual electron-vite config loader and Node failure output", () => {
    const desktop = join(root, "desktop");
    mkdirSync(desktop);
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const helper = pathToFileURL(resolve("scripts/release/build-source.mjs")).href;
    const config = join(desktop, "electron.vite.config.ts");
    writeFileSync(config, `import { readBuildSource } from ${JSON.stringify(helper)};
      export default () => ({ main: { define: { SOURCE: JSON.stringify(readBuildSource(${JSON.stringify(root)}, process.env.GITHUB_SHA)) } } });`);
    git("add", "."); git("commit", "-m", "bind loader to invocation source");
    commit = git("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "unexpected-source.ts"), "PRIVATE FILE CONTENT");
    const hostilePath = "hostile\n\u001b[31m\u202e\u061c\u2060\u{e0001}.ts";
    writeFileSync(join(root, hostilePath), "PRIVATE FILE CONTENT");
    const requireDesktop = createRequire(resolve("desktop/package.json"));
    const compiler = pathToFileURL(requireDesktop.resolve("electron-vite")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { loadConfigFromFile } = await import(${JSON.stringify(compiler)});
      await loadConfigFromFile({command:"build",mode:"production"}, ${JSON.stringify(config)}, ${JSON.stringify(desktop)}, "silent", true);
    `], { cwd: root, env: { ...process.env, GITHUB_SHA: commit }, encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(message);
    expect(child.stderr).toContain("release_checkout_dirty");
    expect(child.stderr).toContain("unexpected-source.ts");
    expect(child.stderr).toMatch(/untrackedCount: 2/);
    expect(child.stderr).toContain("hostile\\\\n\\\\u001b[31m\\\\u202e\\\\u061c\\\\u2060\\\\udb40\\\\udc01.ts");
    expect(child.stderr).not.toContain(hostilePath);
    expect(child.stderr).not.toMatch(/[\u001b\p{Cf}]/u);
    expect(child.stderr).not.toContain("PRIVATE FILE CONTENT");
    expect(git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)).toEqual([hostilePath, "unexpected-source.ts"]);
  });
});
