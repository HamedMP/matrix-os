import { describe, expect, it } from "vitest";
import { DEFAULT_TUI_ACTIONS } from "../../src/cli/tui/actions.js";
import { resolvePaletteEnterAction } from "../../src/cli/tui/app.js";
import { searchTuiActions } from "../../src/cli/tui/palette.js";

describe("command palette dispatch", () => {
  it("resolves the selected palette result for Enter dispatch", () => {
    const results = searchTuiActions(DEFAULT_TUI_ACTIONS, "whoami", 8);

    expect(resolvePaletteEnterAction(results, 0)?.id).toBe("status.whoami");
  });

  it("returns undefined when Enter has no selectable result", () => {
    expect(resolvePaletteEnterAction([], 0)).toBeUndefined();
    expect(resolvePaletteEnterAction(searchTuiActions(DEFAULT_TUI_ACTIONS, "whoami", 8), 99)).toBeUndefined();
  });
});
