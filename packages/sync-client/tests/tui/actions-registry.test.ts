import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUI_ACTIONS,
  getTuiActionById,
  getTuiActionByShortcut,
  validateTuiActionRegistry,
} from "../../src/cli/tui/actions.js";
import { QUICK_ACTION_IDS } from "../../src/cli/tui/quick-actions.js";

describe("foundational TUI action registry", () => {
  it("registers MVP actionable commands with stable shortcuts", () => {
    expect(getTuiActionById("shell.new")?.shortcut).toBe("n");
    expect(getTuiActionById("shell.sessions")?.shortcut).toBe("s");
    expect(getTuiActionById("setup.agents")?.shortcut).toBe("a");
    expect(getTuiActionById("status.doctor")?.shortcut).toBe("d");
    expect(getTuiActionById("account.login")?.shortcut).toBe("l");
    expect(getTuiActionById("status.whoami")).toMatchObject({
      directCommand: "matrix whoami",
      refreshes: ["auth", "profile"],
    });
  });

  it("maps shortcuts to action IDs without duplicate shortcut ownership", () => {
    expect(getTuiActionByShortcut("n")?.id).toBe("shell.new");
    expect(getTuiActionByShortcut("s")?.id).toBe("shell.sessions");
    expect(getTuiActionByShortcut("a")?.id).toBe("setup.agents");
    expect(getTuiActionByShortcut("/")?.id).toBe("utility.palette");
    expect(getTuiActionByShortcut("q")?.id).toBe("utility.quit");

    expect(validateTuiActionRegistry(DEFAULT_TUI_ACTIONS).duplicateShortcuts).toEqual([]);
  });

  it("keeps home quick actions backed by registered actions", () => {
    const actionIds = new Set(DEFAULT_TUI_ACTIONS.map((action) => action.id));

    expect(QUICK_ACTION_IDS.every((id) => actionIds.has(id))).toBe(true);
  });
});
