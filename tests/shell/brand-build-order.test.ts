import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("shell brand package build order", () => {
  it("builds the brand workspace before the Docker shell bundle", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const brandBuild = dockerfile.indexOf("pnpm --filter '@matrix-os/brand' build");
    const shellBuild = dockerfile.indexOf(
      "cd shell && node ../node_modules/next/dist/bin/next build",
    );

    expect(brandBuild).toBeGreaterThan(-1);
    expect(shellBuild).toBeGreaterThan(brandBuild);
  });
});
