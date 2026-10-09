import { describe, expect, it } from "vitest";
import {
  SHELL_WINDOW_Z_INDEX_MAX,
  SHELL_Z_INDEX,
} from "../../shell/src/lib/shell-layering.js";

describe("shell layer ordering", () => {
  it("keeps app windows below settings, notifications, and active popovers", () => {
    expect(SHELL_WINDOW_Z_INDEX_MAX).toBeLessThan(SHELL_Z_INDEX.fullscreenWindow);
    expect(SHELL_Z_INDEX.fullscreenWindow).toBeLessThan(SHELL_Z_INDEX.fullscreenExit);
    expect(SHELL_Z_INDEX.fullscreenExit).toBeLessThan(SHELL_Z_INDEX.settings);
    expect(SHELL_Z_INDEX.settings).toBeLessThan(SHELL_Z_INDEX.hardGate);
    expect(SHELL_Z_INDEX.hardGate).toBeLessThan(SHELL_Z_INDEX.notifications);
    expect(SHELL_Z_INDEX.notifications).toBeLessThan(SHELL_Z_INDEX.popover);
  });
});
