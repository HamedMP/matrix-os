import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUI_ACTIONS,
  REQUIRED_TUI_ACTION_GROUPS,
  getTuiActionById,
  validateTuiActionRegistry,
} from "../../src/cli/tui/actions.js";

describe("TUI action registry", () => {
  it("covers every required command family", () => {
    const report = validateTuiActionRegistry(DEFAULT_TUI_ACTIONS);

    expect(report.missingGroups).toEqual([]);
    expect(new Set(DEFAULT_TUI_ACTIONS.map((action) => action.group))).toEqual(
      new Set(REQUIRED_TUI_ACTION_GROUPS),
    );
  });

  it("requires destructive actions to declare confirmation metadata", () => {
    const report = validateTuiActionRegistry(DEFAULT_TUI_ACTIONS);

    expect(report.unsafeDestructiveActionIds).toEqual([]);
    expect(getTuiActionById("workspace.deleteData")?.confirmationPhrase).toBe(
      "delete project workspace data",
    );
  });
});
