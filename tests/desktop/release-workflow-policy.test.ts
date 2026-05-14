import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("desktop release workflow policy", () => {
  it("defines stacked desktop release workflows and checksum manifest script", () => {
    const workflow = readFileSync(".github/workflows/desktop-release.yml", "utf8");
    const foundation = readFileSync(".github/workflows/desktop-release-foundation.yml", "utf8");
    const smoke = readFileSync("scripts/smoke/desktop-electron-smoke.mjs", "utf8");
    const quickstart = readFileSync("specs/079-desktop-cloud-symphony/quickstart.md", "utf8");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("desktop-release-foundation.yml");
    expect(foundation).toContain("package-script: build:mac");
    expect(foundation).toContain("package-script: build:win");
    expect(foundation).toContain("package-script: build:linux");
    expect(foundation).toContain("scripts/release/desktop/write-manifest.mjs");
    expect(foundation).toContain("CSC_LINK: ${{ secrets.DESKTOP_CSC_LINK }}");
    expect(foundation).toContain("WIN_CSC_LINK: ${{ secrets.DESKTOP_WIN_CSC_LINK }}");
    expect(foundation).toContain("node scripts/release/desktop/write-manifest.mjs apps/desktop/dist \"$DESKTOP_RELEASE_CHANNEL\"");
    expect(smoke).toContain("Run pnpm --dir apps/desktop build");
    expect(quickstart).toContain("pnpm --dir apps/desktop build");
    expect(existsSync("scripts/release/desktop/write-manifest.mjs")).toBe(true);
  });

  it("writes desktop manifest artifact paths relative to the dist directory", () => {
    const dist = mkdtempSync(join(tmpdir(), "matrix-desktop-dist-"));
    try {
      writeFileSync(join(dist, "Matrix.dmg"), "mac artifact");
      execFileSync("node", ["scripts/release/desktop/write-manifest.mjs", dist, "dev"]);
      const manifest = JSON.parse(readFileSync(join(dist, "desktop-release-manifest.json"), "utf8")) as {
        artifacts: Array<{ path: string }>;
      };
      expect(manifest.artifacts).toEqual([expect.objectContaining({ path: "Matrix.dmg" })]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("normalizes nested desktop manifest paths to URL-safe separators", () => {
    const dist = mkdtempSync(join(tmpdir(), "matrix-desktop-dist-"));
    try {
      mkdirSync(join(dist, "win-unpacked"));
      writeFileSync(join(dist, "win-unpacked", "Matrix.exe"), "windows artifact");
      execFileSync("node", ["scripts/release/desktop/write-manifest.mjs", dist, "dev"]);
      const manifest = JSON.parse(readFileSync(join(dist, "desktop-release-manifest.json"), "utf8")) as {
        artifacts: Array<{ path: string }>;
      };
      expect(manifest.artifacts).toEqual([expect.objectContaining({ path: "win-unpacked/Matrix.exe" })]);
      expect(manifest.artifacts[0]?.path).not.toContain("\\");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
