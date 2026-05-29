import { describe, expect, it } from "vitest";
import { DEFAULT_TUI_ACTIONS } from "../../src/cli/tui/actions.js";
import { resolveHomeEnterAction, resolveHomeShortcutAction } from "../../src/cli/tui/app.js";

describe("home shortcut dispatch", () => {
  it("maps quick action shortcuts to registered actions", () => {
    expect(resolveHomeShortcutAction("n", DEFAULT_TUI_ACTIONS)?.id).toBe("shell.new");
    expect(resolveHomeShortcutAction("s", DEFAULT_TUI_ACTIONS)?.id).toBe("shell.sessions");
    expect(resolveHomeShortcutAction("a", DEFAULT_TUI_ACTIONS)?.id).toBe("setup.agents");
    expect(resolveHomeShortcutAction("d", DEFAULT_TUI_ACTIONS)?.id).toBe("status.doctor");
    expect(resolveHomeShortcutAction("l", DEFAULT_TUI_ACTIONS)?.id).toBe("account.login");
  });

  it("maps Enter to the selected quick action", () => {
    expect(resolveHomeEnterAction(DEFAULT_TUI_ACTIONS, 0)?.id).toBe("shell.new");
    expect(resolveHomeEnterAction(DEFAULT_TUI_ACTIONS, 1)?.id).toBe("shell.sessions");
  });
});
