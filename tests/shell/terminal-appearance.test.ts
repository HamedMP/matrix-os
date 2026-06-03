// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { applyTerminalAppearance, type TerminalAppearanceTarget } from "../../shell/src/components/terminal/terminal-appearance.js";

describe("applyTerminalAppearance", () => {
  it("updates xterm options, fits, and refreshes visible rows after theme or font changes", () => {
    const element = document.createElement("div");
    const term: TerminalAppearanceTarget = {
      element,
      rows: 12,
      options: {
        theme: {},
        fontFamily: "",
        fontSize: 13,
        cursorBlink: true,
        cursorStyle: "block",
        smoothScrollDuration: 0,
      },
      refresh: vi.fn(),
    };
    const fitAddon = { fit: vi.fn() };

    applyTerminalAppearance(term, fitAddon, {
      theme: { background: "#000000" },
      fontFamily: '"MesloLGS NF", monospace',
      fontSize: 15,
      cursorBlink: false,
      cursorStyle: "underline",
      smoothScrollDuration: 125,
      ligatures: false,
    });

    expect(term.options).toMatchObject({
      theme: { background: "#000000" },
      fontFamily: '"MesloLGS NF", monospace',
      fontSize: 15,
      cursorBlink: false,
      cursorStyle: "underline",
      smoothScrollDuration: 125,
    });
    expect(element.style.fontVariantLigatures).toBe("none");
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(term.refresh).toHaveBeenCalledWith(0, 11);
  });
});
