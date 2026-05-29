import { describe, expect, it } from "vitest";
import { shouldUseAlternateScreen } from "../../src/cli/tui/app.js";
import { resolveTuiLaunchMode } from "../../src/cli/tui/launch.js";

describe("TUI launch routing", () => {
  it("opens the TUI for bare interactive matrix", () => {
    expect(resolveTuiLaunchMode({ argv: [], stdinIsTTY: true, stdoutIsTTY: true })).toEqual({
      mode: "tui",
      explicit: false,
    });
  });

  it("opens the TUI for explicit matrix tui even when the command is named through aliases", () => {
    expect(resolveTuiLaunchMode({ argv: ["tui"], stdinIsTTY: true, stdoutIsTTY: true })).toEqual({
      mode: "tui",
      explicit: true,
    });
  });

  it("keeps explicit tui help scriptable", () => {
    expect(resolveTuiLaunchMode({ argv: ["tui", "--help"], stdinIsTTY: true, stdoutIsTTY: true })).toEqual({
      mode: "direct",
      reason: "reserved",
    });
  });

  it("does not open the TUI for non-interactive bare invocations", () => {
    expect(resolveTuiLaunchMode({ argv: [], stdinIsTTY: true, stdoutIsTTY: false })).toEqual({
      mode: "help",
      reason: "non-interactive",
    });
  });

  it("opens the TUI for bare interactive matrix with TUI-only flags", () => {
    expect(resolveTuiLaunchMode({ argv: ["--no-color"], stdinIsTTY: true, stdoutIsTTY: true })).toEqual({
      mode: "tui",
      explicit: false,
    });
  });

  it("does not open the TUI for non-interactive bare invocations with TUI-only flags", () => {
    expect(resolveTuiLaunchMode({ argv: ["--no-color"], stdinIsTTY: false, stdoutIsTTY: false })).toEqual({
      mode: "help",
      reason: "non-interactive",
    });
  });

  it("keeps direct commands and help/version scriptable", () => {
    for (const argv of [["--help"], ["help"], ["--version"], ["status"], ["shell", "ls"], ["status", "--json"]]) {
      expect(resolveTuiLaunchMode({ argv, stdinIsTTY: true, stdoutIsTTY: true }).mode).toBe("direct");
    }
  });

  it("uses fullscreen alternate screen only for capable TTYs", () => {
    expect(shouldUseAlternateScreen({
      stdout: { isTTY: true } as NodeJS.WriteStream & { isTTY: boolean },
      env: { TERM: "xterm-256color" },
    })).toBe(true);
    expect(shouldUseAlternateScreen({
      stdout: { isTTY: true } as NodeJS.WriteStream & { isTTY: boolean },
      env: { TERM: "dumb" },
    })).toBe(false);
    expect(shouldUseAlternateScreen({
      stdout: { isTTY: true } as NodeJS.WriteStream & { isTTY: boolean },
      env: { TERM: "xterm-256color", MATRIX_TUI_FULLSCREEN: "0" },
    })).toBe(false);
    expect(shouldUseAlternateScreen({
      stdout: { isTTY: false } as NodeJS.WriteStream & { isTTY: boolean },
      env: { TERM: "xterm-256color" },
    })).toBe(false);
  });
});
