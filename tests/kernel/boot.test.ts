import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, symlinkSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureHome, smartSyncTemplate } from "../../packages/kernel/src/boot.js";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "matrixos-boot-test-"));
}

describe("ensureHome", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates home directory from template on first boot", () => {
    const homePath = join(tmpDir, "home");
    const result = ensureHome(homePath);
    expect(result.homePath).toBe(homePath);
    expect(existsSync(homePath)).toBe(true);
    // Should have copied template contents (at minimum system/ dir)
    expect(existsSync(join(homePath, "system"))).toBe(true);
  });

  it("syncs new template files to existing home without overwriting", () => {
    const homePath = join(tmpDir, "home");
    // Simulate an older home directory with just system/
    mkdirSync(join(homePath, "system"), { recursive: true });
    writeFileSync(join(homePath, "system", "config.json"), '{"custom": true}');

    const result = ensureHome(homePath);
    expect(result.homePath).toBe(homePath);

    // User's custom config should be preserved
    const config = readFileSync(join(homePath, "system", "config.json"), "utf-8");
    expect(config).toBe('{"custom": true}');

    // New template files should be added (apps/ dir from template)
    expect(existsSync(join(homePath, "apps"))).toBe(true);
  });

  it("does not overwrite existing files during sync", () => {
    const homePath = join(tmpDir, "home");
    // Create home with a file that also exists in template
    mkdirSync(join(homePath, "agents", "skills"), { recursive: true });
    writeFileSync(join(homePath, "agents", "skills", "my-skill.md"), "user content");

    ensureHome(homePath);

    // User's file should be untouched
    const content = readFileSync(join(homePath, "agents", "skills", "my-skill.md"), "utf-8");
    expect(content).toBe("user content");
  });

  it("adds entire missing directories", () => {
    const homePath = join(tmpDir, "home");
    mkdirSync(homePath, { recursive: true });

    ensureHome(homePath);

    // apps/ directory should now exist with game subdirectories
    expect(existsSync(join(homePath, "apps"))).toBe(true);
    expect(existsSync(join(homePath, "apps", "games"))).toBe(true);
  });

  it("is idempotent - running twice doesn't duplicate or error", () => {
    const homePath = join(tmpDir, "home");
    mkdirSync(homePath, { recursive: true });

    ensureHome(homePath);
    ensureHome(homePath);

    expect(existsSync(join(homePath, "apps"))).toBe(true);
  });

  it("adds missing bundled icons to an existing home without replacing owner artwork", () => {
    const homePath = join(tmpDir, "home");
    mkdirSync(join(homePath, "system", "icons"), { recursive: true });
    writeFileSync(join(homePath, "system", "icons", "v3-notes.png"), "owner artwork");

    const result = ensureHome(homePath);

    expect(readFileSync(join(homePath, "system", "icons", "v3-launcher.svg")))
      .toEqual(readFileSync(join(process.cwd(), "home", "system", "icons", "v3-launcher.svg")));
    expect(readFileSync(join(homePath, "system", "icons", "v3-notes.png"), "utf-8"))
      .toBe("owner artwork");
    expect(result.added).toContain("system/icons/v3-launcher.svg");
    expect(result.skipped).toContain("system/icons/v3-notes.png");
  });

  it("does not follow an icon symlink in an existing home", () => {
    const homePath = join(tmpDir, "home");
    const outside = join(tmpDir, "outside.svg");
    mkdirSync(join(homePath, "system", "icons"), { recursive: true });
    writeFileSync(outside, "outside artwork");
    symlinkSync(outside, join(homePath, "system", "icons", "v3-launcher.svg"));

    const result = ensureHome(homePath);

    expect(lstatSync(join(homePath, "system", "icons", "v3-launcher.svg")).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf-8")).toBe("outside artwork");
    expect(result.skipped).toContain("system/icons/v3-launcher.svg");
  });

  it("keeps a custom SVG visible when the same-stem bundled PNG is missing", () => {
    const homePath = join(tmpDir, "home");
    mkdirSync(join(homePath, "system", "icons"), { recursive: true });
    writeFileSync(join(homePath, "system", "icons", "v3-profile.svg"), "owner SVG");

    const result = ensureHome(homePath);

    expect(existsSync(join(homePath, "system", "icons", "v3-profile.png"))).toBe(false);
    expect(readFileSync(join(homePath, "system", "icons", "v3-profile.svg"), "utf-8"))
      .toBe("owner SVG");
    expect(result.skipped).toContain("system/icons/v3-profile.png");
  });

  it("skips a missing PNG when the owner SVG cannot be read", () => {
    const homePath = join(tmpDir, "home");
    const svgPath = join(homePath, "system", "icons", "v3-profile.svg");
    mkdirSync(join(homePath, "system", "icons"), { recursive: true });
    writeFileSync(svgPath, "private owner SVG");
    chmodSync(svgPath, 0o000);

    try {
      const result = ensureHome(homePath);
      expect(existsSync(join(homePath, "system", "icons", "v3-profile.png"))).toBe(false);
      expect(result.skipped).toContain("system/icons/v3-profile.png");
      expect(readFileSync(join(homePath, "system", "logs", "template-sync.log"), "utf-8"))
        .toMatch(/v3-profile\.png.*EACCES/);
    } finally {
      chmodSync(svgPath, 0o600);
    }
  });

  it("adds a missing PNG when a same-stem SVG is unchanged bundled artwork", () => {
    const homePath = join(tmpDir, "home");
    const templatePath = join(tmpDir, "template");
    mkdirSync(join(homePath, "system", "icons"), { recursive: true });
    mkdirSync(join(templatePath, "system", "icons"), { recursive: true });
    writeFileSync(join(templatePath, "system", "icons", "example.svg"), "bundled SVG");
    writeFileSync(join(templatePath, "system", "icons", "example.png"), "bundled PNG");
    writeFileSync(join(templatePath, ".template-manifest.json"), JSON.stringify({
      "system/icons/example.svg": "svg hash",
      "system/icons/example.png": "png hash",
    }));
    writeFileSync(join(homePath, "system", "icons", "example.svg"), "bundled SVG");

    const result = smartSyncTemplate(homePath, templatePath);

    expect(readFileSync(join(homePath, "system", "icons", "example.png"), "utf-8"))
      .toBe("bundled PNG");
    expect(result.added).toContain("system/icons/example.png");
  });

  it("rejects a symlinked icon directory before copying bundled icons", () => {
    const homePath = join(tmpDir, "home");
    const outside = join(tmpDir, "outside-icons");
    mkdirSync(join(homePath, "system"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(homePath, "system", "icons"));

    expect(() => ensureHome(homePath)).toThrow(/symlink/i);
    expect(existsSync(join(outside, "v3-launcher.svg"))).toBe(false);
  });
});
