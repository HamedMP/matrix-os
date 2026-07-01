import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_APP_THEME_ID,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_THEME_ID,
} from "../../shell/src/stores/terminal-defaults.js";

describe("terminal settings defaults", () => {
  it("defaults new terminal settings to a dark terminal theme", () => {
    expect(DEFAULT_TERMINAL_THEME_ID).toBe("dark");
  });

  it("defaults terminal app chrome to Matrix OS Dark", () => {
    expect(DEFAULT_TERMINAL_APP_THEME_ID).toBe("matrix-dark");
  });

  it("defaults new terminal sessions to a roomy font size", () => {
    expect(DEFAULT_TERMINAL_FONT_SIZE).toBe(15);
  });
});
