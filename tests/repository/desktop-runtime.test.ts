import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("desktop runtime boundary", () => {
  it("keeps Electron as the sole desktop shell", () => {
    expect(existsSync(join(root, "desktop/package.json"))).toBe(true);
    expect(readFileSync(join(root, "desktop/package.json"), "utf8")).toContain('"electron"');
    expect(existsSync(join(root, "macos"))).toBe(false);
    expect(existsSync(join(root, ".github/workflows/macos-086.yml"))).toBe(false);
    expect(existsSync(join(root, ".codex/environments/environment.toml"))).toBe(false);
    expect(existsSync(join(root, "script/build_and_run.sh"))).toBe(false);
  });
});
