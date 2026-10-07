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
  it("covers desktop chrome with voice while leaving settings and hard gates above it", () => {
    expect(Math.max(SHELL_Z_INDEX.desktopHeader, SHELL_Z_INDEX.taskbar, SHELL_Z_INDEX.launchpad))
      .toBeLessThan(SHELL_Z_INDEX.voiceBackdrop);
    expect(SHELL_Z_INDEX.voiceBackdrop).toBeLessThan(SHELL_Z_INDEX.voiceCompanion);
    expect(SHELL_Z_INDEX.voiceCompanion).toBeLessThan(SHELL_Z_INDEX.settings);
  });
});
