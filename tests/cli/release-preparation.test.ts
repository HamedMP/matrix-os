import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const releaseVersion = "0.3.15";

function readSection(markdown: string, heading: string): string {
  const marker = `## ${heading}\n`;
  const start = markdown.indexOf(marker);
  expect(start, `missing "${heading}" section`).toBeGreaterThanOrEqual(0);

  const contentStart = start + marker.length;
  const nextSection = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(contentStart, nextSection === -1 ? undefined : nextSection);
}

describe("Matrix CLI release preparation", () => {
  it("keeps the package and release runbook on the prepared version", () => {
    const packageJson = JSON.parse(
      readFileSync(join(root, "packages/sync-client/package.json"), "utf8"),
    ) as { version?: string };
    const runbook = readFileSync(join(root, "docs/dev/cli-release.md"), "utf8");
    const preparedRelease = readSection(runbook, "Current Prepared Release");
    const release = readSection(runbook, "Release");
    const verificationLines = new Set(
      readSection(runbook, "Post-Release Verification").split(/\r?\n/),
    );

    expect(packageJson.version).toBe(releaseVersion);
    expect(preparedRelease.trimStart()).toMatch(
      new RegExp(`^\\\`${releaseVersion}\\\` is the prepared CLI patch release`),
    );
    expect(release).toContain(`with \`version=${releaseVersion}\``);
    expect(verificationLines).toContain(`MATRIX_VERSION=${releaseVersion} sh scripts/install.sh`);
    expect(verificationLines).toContain(`- \`matrix-${releaseVersion}-linux-x64\``);
    expect(verificationLines).toContain(`- \`matrix-${releaseVersion}-linux-arm64\``);
    expect(verificationLines).toContain(`- \`matrix-${releaseVersion}-darwin-x64\``);
    expect(verificationLines).toContain(`- \`matrix-${releaseVersion}-darwin-arm64\``);
    expect(verificationLines).toContain(
      `For macOS app packaging, also verify the GitHub release contains \`MatrixSync-${releaseVersion}.pkg\` when the macOS job was enabled.`,
    );
  });
});
