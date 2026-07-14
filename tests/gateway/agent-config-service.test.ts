import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  hasClaudeLogin,
  readRuntimeSnapshot,
} from "../../packages/gateway/src/agent-config/service.js";

describe("agent runtime settings probe", () => {
  it("aborts a runtime source that exceeds its deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const result = readRuntimeSnapshot(async (signal) => {
      observedSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("source completed after its deadline");
    }, 5);

    await expect(result).rejects.toThrow("Runtime settings probe timed out");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not log raw owner login parse failures", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-login-status-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeFile(
        join(homePath, ".claude.json"),
        '{"oauthAccount":"owner-secret-canary"',
      );

      await expect(hasClaudeLogin(homePath)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        "[agent-config] Failed to read owner login status:",
        "SyntaxError",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("owner-secret-canary");
    } finally {
      warn.mockRestore();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
