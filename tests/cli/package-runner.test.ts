import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatUnsupportedNodeError,
  isSupportedNodeVersion,
  nodeMajor,
} from "../../packages/sync-client/src/lib/node-runtime-guard.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");

describe("published CLI package runners", () => {
  it("keeps package metadata compatible with npx and pnpm dlx", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repoRoot, "packages/sync-client/package.json"), "utf8"),
    );

    expect(packageJson.name).toBe("@finnaai/matrix");
    expect(packageJson.engines.node).toBe(">=24");
    expect(packageJson.bin).toEqual({
      matrix: "bin/matrix.mjs",
      matrixos: "bin/matrix.mjs",
      mos: "bin/matrix.mjs",
    });
    expect(packageJson.files).toEqual(expect.arrayContaining(["bin/", "src/", "README.md"]));
    expect(packageJson.publishConfig).toMatchObject({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
  });

  it("reports Node runtime prerequisites before loading the TypeScript CLI", () => {
    expect(nodeMajor("24.14.1")).toBe(24);
    expect(isSupportedNodeVersion("24.0.0")).toBe(true);
    expect(formatUnsupportedNodeError("23.11.0", false)).toContain("Matrix CLI requires Node.js 24 or newer");
  });
});
