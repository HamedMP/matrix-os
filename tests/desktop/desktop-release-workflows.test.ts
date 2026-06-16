import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("desktop release workflows", () => {
  it("renames mac update manifests before artifact upload", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");

    expect(workflow).toContain("Rename mac update manifest for arch");
    expect(workflow).toContain("test -f desktop/dist/latest-mac.yml");
    expect(workflow).not.toContain("test -f desktop/dist/*-mac.yml");
    expect(workflow).toContain('mv desktop/dist/latest-mac.yml "desktop/dist/${{ matrix.arch }}-mac.yml"');
    expect(workflow).toContain('mv "desktop/dist/${CHANNEL}-mac.yml" "desktop/dist/${{ matrix.arch }}-${CHANNEL}-mac.yml"');
    expect(workflow).toContain('! -name "${{ matrix.arch }}-mac.yml"');
    expect(workflow).toContain('! -name "${{ matrix.arch }}-${CHANNEL}-mac.yml"');
    expect(workflow).toContain("desktop/dist/*-mac.yml");
  });

  it("records the full canary app version in the release manifest", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-release-canary.yml"), "utf8");

    expect(workflow).toContain("version: ${{ steps.meta.outputs.version }}");
    expect(workflow).toContain("version: ${{ needs.prepare.outputs.version }}");
    expect(workflow).toContain("BASE_VERSION=");
    expect(workflow).toContain('echo "version=$BASE_VERSION-$SUFFIX" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('${{ needs.prepare.outputs.version }}" canary "$GITHUB_SHA"');
    expect(workflow).not.toContain('${{ needs.prepare.outputs.suffix }}" canary "$GITHUB_SHA"');
    expect(workflow).not.toContain("version_suffix:");
  });

  it("patches exact release versions and validates notarization inputs before packaging", () => {
    const build = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");
    const release = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");
    const canary = readFileSync(join(root, ".github/workflows/desktop-release-canary.yml"), "utf8");

    expect(build).toContain("Validate Apple notarization secrets");
    expect(build).toContain("APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must be set together");
    expect(build).toContain("Apply desktop release version");
    expect(build).toContain("RELEASE_VERSION: ${{ inputs.version }}");
    expect(build).toContain("j.version = exact ||");
    expect(release).toContain("version: ${{ needs.prepare.outputs.version }}");
    expect(release).toContain("overwrite_files: true");
    expect(release).toContain("Merge channel macOS update manifests");
    expect(release).toContain("output: ${{ needs.prepare.outputs.channel }}-mac.yml");
    expect(canary).toContain("Merge canary macOS update manifests");
    expect(canary).toContain("output: canary-mac.yml");
  });

  it("merges mac manifests in deterministic filename order", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-desktop-release-"));
    try {
      writeFileSync(
        join(dir, "x64-mac.yml"),
        "version: 1.2.3\nfiles:\n  - url: x64.zip\n    sha512: x64\n    size: 2\npath: x64.zip\nsha512: x64\n",
      );
      writeFileSync(
        join(dir, "arm64-mac.yml"),
        "version: 1.2.3\nfiles:\n  - url: arm64.zip\n    sha512: arm64\n    size: 1\npath: arm64.zip\nsha512: arm64\n",
      );

      execFileSync(process.execPath, [join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs")], {
        env: { ...process.env, INPUT_DIRECTORY: dir },
      });

      const merged = readFileSync(join(dir, "latest-mac.yml"), "utf8");
      expect(merged.indexOf("url: arm64.zip")).toBeLessThan(merged.indexOf("url: x64.zip"));
      expect(merged).toContain("path: arm64.zip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores an existing latest-mac manifest when merging stable arch manifests", () => {
    const script = readFileSync(join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs"), "utf8");

    expect(script).toContain("return /^(arm64|x64)-mac\\.yml$/.test(name);");
    expect(script).not.toContain('name === "latest-mac.yml"');
  });

  it("merges prerelease mac channel manifests separately from latest manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-desktop-release-"));
    try {
      writeFileSync(
        join(dir, "x64-mac.yml"),
        "version: 1.2.3\nfiles:\n  - url: x64.zip\n    sha512: x64\n    size: 2\npath: x64.zip\nsha512: x64\n",
      );
      writeFileSync(
        join(dir, "arm64-mac.yml"),
        "version: 1.2.3\nfiles:\n  - url: arm64.zip\n    sha512: arm64\n    size: 1\npath: arm64.zip\nsha512: arm64\n",
      );
      writeFileSync(
        join(dir, "x64-beta-mac.yml"),
        "version: 1.2.3-beta.1\nfiles:\n  - url: beta-x64.zip\n    sha512: beta-x64\n    size: 2\npath: beta-x64.zip\nsha512: beta-x64\n",
      );
      writeFileSync(
        join(dir, "arm64-beta-mac.yml"),
        "version: 1.2.3-beta.1\nfiles:\n  - url: beta-arm64.zip\n    sha512: beta-arm64\n    size: 1\npath: beta-arm64.zip\nsha512: beta-arm64\n",
      );

      execFileSync(process.execPath, [join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs")], {
        env: { ...process.env, INPUT_DIRECTORY: dir },
      });
      execFileSync(process.execPath, [join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs")], {
        env: { ...process.env, INPUT_DIRECTORY: dir, INPUT_OUTPUT: "beta-mac.yml", INPUT_CHANNEL: "beta" },
      });

      const latest = readFileSync(join(dir, "latest-mac.yml"), "utf8");
      const beta = readFileSync(join(dir, "beta-mac.yml"), "utf8");
      expect(latest).toContain("url: arm64.zip");
      expect(latest).toContain("url: x64.zip");
      expect(latest).not.toContain("beta-arm64.zip");
      expect(beta).toContain("url: beta-arm64.zip");
      expect(beta).toContain("url: beta-x64.zip");
      expect(beta).not.toContain("url: arm64.zip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
