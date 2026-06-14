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
    expect(workflow).toContain('mv desktop/dist/latest-mac.yml "desktop/dist/${{ matrix.arch }}-mac.yml"');
    expect(workflow).toContain("desktop/dist/*-mac.yml");
  });

  it("records the full canary app version in the release manifest", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-release-canary.yml"), "utf8");

    expect(workflow).toContain("version: ${{ steps.meta.outputs.version }}");
    expect(workflow).toContain("BASE_VERSION=");
    expect(workflow).toContain('echo "version=$BASE_VERSION-$SUFFIX" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('${{ needs.prepare.outputs.version }}" canary "$GITHUB_SHA"');
    expect(workflow).not.toContain('${{ needs.prepare.outputs.suffix }}" canary "$GITHUB_SHA"');
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
});
