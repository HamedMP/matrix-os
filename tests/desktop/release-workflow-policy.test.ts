import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop release workflow policy", () => {
  it("defines stacked desktop release workflows and checksum manifest script", () => {
    const workflow = readFileSync(".github/workflows/desktop-release.yml", "utf8");
    const foundation = readFileSync(".github/workflows/desktop-release-foundation.yml", "utf8");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("desktop-release-foundation.yml");
    expect(foundation).toContain("pnpm --dir apps/desktop build");
    expect(foundation).toContain("scripts/release/desktop/write-manifest.mjs");
    expect(existsSync("scripts/release/desktop/write-manifest.mjs")).toBe(true);
  });
});
