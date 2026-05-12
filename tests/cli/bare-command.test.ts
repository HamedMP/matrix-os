import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("bare matrix command", () => {
  it("prints help without treating empty argv as an error", () => {
    const result = spawnSync(process.execPath, [
      "packages/sync-client/bin/matrix.mjs",
    ], {
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "development",
      },
    });

    expect(result.status).toBe(0);
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const output = `${stdout}${stderr}`;
    expect(output).toContain("Matrix OS CLI");
    expect(output).toContain("USAGE matrixos");
    expect(output).not.toContain("No command specified");
  });
});
