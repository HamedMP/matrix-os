import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("contracts barrel portability", () => {
  it("routes collaborative app sharing through the package import map for clean Jest installs", () => {
    const root = process.cwd();
    const index = readFileSync(join(root, "packages/contracts/src/index.ts"), "utf8");
    const manifest = JSON.parse(readFileSync(join(root, "packages/contracts/package.json"), "utf8")) as {
      imports?: Record<string, string>;
    };

    expect(index).toContain('export * from "#collaborative-app-sharing";');
    expect(manifest.imports?.["#collaborative-app-sharing"]).toBe("./src/collaborative-app-sharing.ts");
  });
});
