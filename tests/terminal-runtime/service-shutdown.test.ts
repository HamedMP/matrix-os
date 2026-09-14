import { describe, expect, it, vi } from "vitest";
import { runBestEffortTerminalShutdown } from "../../packages/terminal-runtime/src/service-shutdown.js";

describe("terminal runtime service shutdown", () => {
  it("logs a bounded runtime close failure without rejecting signal shutdown", async () => {
    const log = vi.fn();

    await expect(runBestEffortTerminalShutdown(
      async () => { throw new Error("Terminal observer close timed out"); },
      log,
    )).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[terminal-runtime] graceful shutdown incomplete:", "Error");
  });
});
