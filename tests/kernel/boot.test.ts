import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureHome } from "../../packages/kernel/src/boot.js";

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
});
