import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const ignored = (path: string) => {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", path], { cwd: root, stdio: "ignore", timeout: 10_000 });
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "status" in error && error.status === 1) return false;
    throw error;
  }
};

// readBuildSource (scripts/release/build-source.mjs) rejects untracked files when
// GITHUB_SHA is set. electron-vite writes the bundled config next to the source
// while loading it, so a concurrent load in another test worker would otherwise
// fail with "Release checkout has uncommitted source changes".
describe("electron-vite temporary config bundles", () => {
  it("are ignored so concurrent config loads keep the checkout clean", () => {
    expect(ignored("desktop/electron.vite.config.1792001262925.mjs")).toBe(true);
  });

  it("do not hide the real config or other desktop sources", () => {
    expect(ignored("desktop/electron.vite.config.ts")).toBe(false);
    expect(ignored("desktop/electron.vite.config.local.mjs")).toBe(false);
    expect(ignored("desktop/src/main/index.ts")).toBe(false);
  });
});
