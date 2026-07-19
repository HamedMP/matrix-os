import { describe, expect, it } from "vitest";
import { assertCodexProviderVersion } from "../../packages/gateway/src/coding-agents/codex-provider-version-check.mjs";

describe("Codex provider spawn version", () => {
  it("accepts only the exact expected executable version", async () => {
    const currentNodeVersion = process.version.slice(1);

    await expect(assertCodexProviderVersion({
      command: process.execPath,
      expectedVersion: currentNodeVersion,
      cwd: process.cwd(),
    })).resolves.toBeUndefined();

    await expect(assertCodexProviderVersion({
      command: process.execPath,
      expectedVersion: "0.0.0",
      cwd: process.cwd(),
    })).rejects.toThrow("Codex provider version is not verified");
  });
});
