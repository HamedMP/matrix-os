import { describe, expect, it } from "vitest";
import { resolveTerminalRuntimeLimits } from "../../packages/terminal-runtime/src/runtime-config.js";

describe("terminal runtime admission configuration", () => {
  it("uses safe defaults and accepts bounded increases", () => {
    expect(resolveTerminalRuntimeLimits({})).toEqual({
      maxTabsPerWorkspace: 64,
      maxTabsTotal: 256,
    });
    expect(resolveTerminalRuntimeLimits({
      MATRIX_TERMINAL_MAX_TABS_PER_WORKSPACE: "128",
      MATRIX_TERMINAL_MAX_TABS_TOTAL: "512",
    })).toEqual({ maxTabsPerWorkspace: 128, maxTabsTotal: 512 });
  });

  it("rejects malformed, unbounded, and internally inconsistent limits", () => {
    expect(() => resolveTerminalRuntimeLimits({ MATRIX_TERMINAL_MAX_TABS_PER_WORKSPACE: "0" }))
      .toThrow("Invalid terminal runtime limits");
    expect(() => resolveTerminalRuntimeLimits({ MATRIX_TERMINAL_MAX_TABS_TOTAL: "many" }))
      .toThrow("Invalid terminal runtime limits");
    expect(() => resolveTerminalRuntimeLimits({
      MATRIX_TERMINAL_MAX_TABS_PER_WORKSPACE: "65",
      MATRIX_TERMINAL_MAX_TABS_TOTAL: "64",
    })).toThrow("Invalid terminal runtime limits");
  });
});
