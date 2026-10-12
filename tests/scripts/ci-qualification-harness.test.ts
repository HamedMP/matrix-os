import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../");
describe("immutable public-source qualification", () => {
  it("passes bounded real Git, provenance, inventory and evidence contracts", () => {
    const result = execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests/scripts/qualification-harness", "-p", "test_*.py", "-v"], {
      cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(result).not.toContain("FAILED");
  }, 125_000);
  it("keeps image modules focused and free of frozen private source transport", () => {
    const directory = path.join(root, "scripts/ci/qualification");
    for (const name of readdirSync(directory).filter((name) => /\.(py|sh|mjs)$/.test(name))) {
      const source = readFileSync(path.join(directory, name), "utf8");
      expect(source.split("\n").length, name).toBeLessThan(500);
      expect(source, name).not.toMatch(/5677467e|source\.bundle|BUNDLE_PREREQUISITES|GitHub_TOKEN|GITHUB_TOKEN/);
    }
  });
});
