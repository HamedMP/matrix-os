import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeMajor, nodeVersionError } from "../../packages/sync-client/src/lib/runtime-prereqs.mjs";

describe("published CLI package runners", () => {
  it("keeps package metadata compatible with npx and pnpm dlx", async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), "packages/sync-client/package.json"), "utf8"),
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
    expect(nodeVersionError("24.0.0")).toBeNull();
    expect(nodeVersionError("23.11.0")).toContain("matrix CLI requires Node.js 24 or newer");
  });
});
