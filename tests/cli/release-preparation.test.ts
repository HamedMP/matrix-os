import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const releaseVersion = "0.3.15";

describe("Matrix CLI release preparation", () => {
  it("keeps the package and release runbook on the prepared version", () => {
    const packageJson = JSON.parse(
      readFileSync(join(root, "packages/sync-client/package.json"), "utf8"),
    ) as { version?: string };
    const runbook = readFileSync(join(root, "docs/dev/cli-release.md"), "utf8");

    expect(packageJson.version).toBe(releaseVersion);
    expect(runbook).toContain(`\`${releaseVersion}\` is the prepared CLI patch release`);
    expect(runbook).toContain(`version=${releaseVersion}`);
    expect(runbook).toContain(`MATRIX_VERSION=${releaseVersion}`);
    expect(runbook).toContain(`matrix-${releaseVersion}-linux-x64`);
    expect(runbook).toContain(`matrix-${releaseVersion}-linux-arm64`);
    expect(runbook).toContain(`matrix-${releaseVersion}-darwin-x64`);
    expect(runbook).toContain(`matrix-${releaseVersion}-darwin-arm64`);
    expect(runbook).toContain(`MatrixSync-${releaseVersion}.pkg`);
  });
});
