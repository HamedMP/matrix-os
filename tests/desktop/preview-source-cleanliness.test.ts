import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readDesktopBuildSource } from "../../scripts/release/build-source.mjs";

it("keeps preview helpers outside immutable source until compilation captures provenance", () => {
  const outer = mkdtempSync(join(tmpdir(), "matrix-preview-cleanliness-"));
  const source = join(outer, "source"), controllerTools = join(source, ".preview-tools");
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: source, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    mkdirSync(join(source, "desktop"), { recursive: true });
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Preview fixture");
    writeFileSync(join(source, "desktop/package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
    git("add", "desktop/package.json");
    git("commit", "-m", "test: immutable candidate");
    const head = git("rev-parse", "HEAD");
    const env = { GITHUB_SHA: head, MATRIX_DESKTOP_BUILD_SOURCE_SHA: head };
    mkdirSync(controllerTools);
    writeFileSync(join(controllerTools, "trusted-config.mjs"), "export default {};");
    expect(() => readDesktopBuildSource(source, env)).toThrow(/uncommitted/);
    renameSync(controllerTools, join(outer, "isolated-controller-tools"));
    expect(readDesktopBuildSource(source, env)?.commit).toBe(head);
    // Package-version stamping remains the only permitted tracked source change.
    writeFileSync(join(source, "desktop/package.json"), JSON.stringify({ name: "fixture", version: "0.1.0-pr1.fixture" }));
    expect(readDesktopBuildSource(source, env)?.commit).toBe(head);
    writeFileSync(join(source, "desktop/.matrix-preview-windows-config.mjs"), "export default {};");
    expect(() => readDesktopBuildSource(source, env)).toThrow(/uncommitted/);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});
