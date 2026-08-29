import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFixtureManifestName } from "../../scripts/release/desktop-update-fixture-server.mjs";

const root = process.cwd();

describe("desktop update fixture server", () => {
  it("prints a parseable channel manifest for packaged updater smoke tests", () => {
    const manifest = execFileSync(
      process.execPath,
      [
        join(root, "scripts/release/desktop-update-fixture-server.mjs"),
        "--channel",
        "canary",
        "--version",
        "0.1.0-canary.20260819015415",
        "--print",
      ],
      { encoding: "utf8" },
    );

    expect(manifest).toContain("version: 0.1.0-canary.20260819015415");
    expect(manifest).toContain("files:");
    expect(manifest).toContain("url: fixture.zip");
    expect(manifest).toContain("sha512:");
    expect(manifest).toContain("releaseNotes: |-");
  });

  it.each([
    ["mac", "latest-mac.yml", "beta-mac.yml"],
    ["windows", "latest.yml", "beta.yml"],
    ["linux", "latest-linux.yml", "beta-linux.yml"],
  ])("resolves stable and prerelease manifest names for %s", (platform, stable, beta) => {
    expect(resolveFixtureManifestName(platform, "stable")).toBe(stable);
    expect(resolveFixtureManifestName(platform, "beta")).toBe(beta);
  });
});
