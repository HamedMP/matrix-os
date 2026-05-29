import { describe, expect, it, vi } from "vitest";
import { createTuiActionExecutor } from "../../src/cli/tui/action-executor.js";
import type { TuiAction } from "../../src/cli/tui/actions.js";
import { healthyTuiSnapshot, loggedOutTuiSnapshot } from "./test-utils.js";

const directAction: TuiAction = {
  id: "status.whoami",
  title: "Show whoami",
  group: "Status and Doctor",
  aliases: ["me"],
  intents: ["show account"],
  directCommand: "matrix whoami",
  prerequisites: ["auth"],
  refreshes: ["auth", "profile"],
  danger: "none",
  handler: "view",
};

describe("TUI action executor", () => {
  it("dispatches registered direct commands through the injected runner", async () => {
    const runDirectCommand = vi.fn(async () => ({ exitCode: 0, output: "Logged in" }));
    const executor = createTuiActionExecutor({ runDirectCommand, now: () => new Date("2026-05-29T12:00:00.000Z") });

    const result = await executor.execute(directAction, { snapshot: healthyTuiSnapshot });

    expect(runDirectCommand).toHaveBeenCalledWith(directAction, { signal: expect.any(AbortSignal) });
    expect(result).toMatchObject({
      actionId: "status.whoami",
      status: "succeeded",
      message: "Logged in",
      refreshes: ["auth", "profile"],
      completedAt: "2026-05-29T12:00:00.000Z",
    });
  });

  it("returns a safe prerequisite failure without running the command", async () => {
    const runDirectCommand = vi.fn(async () => ({ exitCode: 0, output: "should not run" }));
    const executor = createTuiActionExecutor({ runDirectCommand });

    const result = await executor.execute(directAction, { snapshot: loggedOutTuiSnapshot });

    expect(runDirectCommand).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("action_unavailable");
    expect(result.message).toBe("Missing prerequisite: auth");
  });
});
