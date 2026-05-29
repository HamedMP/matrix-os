import { describe, expect, it } from "vitest";
import { DEFAULT_TUI_ACTIONS, REQUIRED_TUI_ACTION_GROUPS } from "../../src/cli/tui/actions.js";

describe("TUI action command-family coverage", () => {
  it("keeps every required command family searchable and executable", () => {
    for (const group of REQUIRED_TUI_ACTION_GROUPS) {
      const actions = DEFAULT_TUI_ACTIONS.filter((action) => action.group === group);
      expect(actions.length, group).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.title.trim()).not.toBe("");
        expect([...action.aliases, ...action.intents].join(" ").trim()).not.toBe("");
        expect(["view", "flow", "direct-command", "external-attach"]).toContain(action.handler);
      }
    }
  });
});
