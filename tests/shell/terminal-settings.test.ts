import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_THEME_ID } from "../../shell/src/stores/terminal-defaults.js";

describe("terminal settings defaults", () => {
  it("defaults new terminal settings to a dark terminal theme", () => {
    expect(DEFAULT_TERMINAL_THEME_ID).toBe("one-dark");
  });
});
