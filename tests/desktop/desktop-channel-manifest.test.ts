import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const script = join(root, "scripts/release/prepare-desktop-channel-manifests.mjs");

describe("Desktop channel manifests", () => {
  it("points channel manifests at immutable artifacts and embeds release notes", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-desktop-channel-"));
    const source = join(dir, "release");
    const output = join(dir, "channel");
    const notes = join(dir, "RELEASE_NOTES.md");
    mkdirSync(source);
    writeFileSync(
      join(source, "canary-mac.yml"),
      "version: 1.2.3-canary.2\nfiles:\n  - url: arm64.zip\n    sha512: arm64\n  - url: x64.zip\n    sha512: x64\npath: arm64.zip\nsha512: arm64\n",
    );
    writeFileSync(
      join(source, "canary-linux.yml"),
      "version: 1.2.3-canary.2\nfiles:\n  - url: app.AppImage\n    sha512: linux\npath: app.AppImage\nsha512: linux\n",
    );
    writeFileSync(notes, "## Improved\n\n- Faster startup\n");

    try {
      execFileSync(process.execPath, [
        script,
        source,
        output,
        "HamedMP",
        "matrix-os",
        "desktop-v1.2.3-canary.2",
        "canary",
        notes,
      ]);

      const mac = readFileSync(join(output, "canary-mac.yml"), "utf8");
      const linux = readFileSync(join(output, "canary-linux.yml"), "utf8");
      expect(mac).toContain(
        "url: https://github.com/HamedMP/matrix-os/releases/download/desktop-v1.2.3-canary.2/arm64.zip",
      );
      expect(mac).toContain(
        "path: https://github.com/HamedMP/matrix-os/releases/download/desktop-v1.2.3-canary.2/arm64.zip",
      );
      expect(linux).toContain(
        "url: https://github.com/HamedMP/matrix-os/releases/download/desktop-v1.2.3-canary.2/app.AppImage",
      );
      expect(mac).toContain("releaseNotes: |-\n  ## Improved\n  \n  - Faster startup\n");
      expect(linux).toContain("releaseNotes: |-\n  ## Improved\n  \n  - Faster startup\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
