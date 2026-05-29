import { describe, expect, it, vi } from "vitest";
import { executeTuiActionWithRefresh } from "../../src/cli/tui/app.js";
import type { TuiAction } from "../../src/cli/tui/actions.js";
import type { TuiActionExecutor } from "../../src/cli/tui/action-executor.js";
import { gatewayUnavailableTuiSnapshot, healthyTuiSnapshot } from "./test-utils.js";

const action: TuiAction = {
  id: "status.doctor",
  title: "Run doctor",
  group: "Status and Doctor",
  aliases: ["doctor"],
  intents: ["diagnose"],
  directCommand: "matrix doctor",
  refreshes: ["gateway", "sessions"],
  danger: "none",
  handler: "view",
};

describe("action status refresh", () => {
  it("refreshes the status snapshot after successful refreshable actions", async () => {
    const executor: TuiActionExecutor = {
      execute: vi.fn(async () => ({
        actionId: action.id,
        status: "succeeded",
        message: "OK",
        refreshes: ["gateway", "sessions"],
        completedAt: "2026-05-29T12:00:00.000Z",
      })),
    };
    const loadStatusSnapshot = vi.fn(async () => healthyTuiSnapshot);

    const result = await executeTuiActionWithRefresh({
      action,
      executor,
      snapshot: gatewayUnavailableTuiSnapshot,
      loadStatusSnapshot,
    });

    expect(loadStatusSnapshot).toHaveBeenCalledOnce();
    expect(result.snapshot).toBe(healthyTuiSnapshot);
  });

  it("does not refresh after failed actions", async () => {
    const executor: TuiActionExecutor = {
      execute: vi.fn(async () => ({
        actionId: action.id,
        status: "failed",
        message: "Request failed",
        refreshes: ["gateway"],
        completedAt: "2026-05-29T12:00:00.000Z",
      })),
    };
    const loadStatusSnapshot = vi.fn(async () => healthyTuiSnapshot);

    await executeTuiActionWithRefresh({
      action,
      executor,
      snapshot: gatewayUnavailableTuiSnapshot,
      loadStatusSnapshot,
    });

    expect(loadStatusSnapshot).not.toHaveBeenCalled();
  });
});
