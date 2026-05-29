import { describe, expect, it } from "vitest";
import { conciseNonInteractiveHelp, resolveTuiLaunchMode } from "../../src/cli/tui/launch.js";

describe("non-interactive compatibility", () => {
  it("does not render TUI for bare non-TTY invocation", () => {
    expect(resolveTuiLaunchMode({ argv: [], stdinIsTTY: false, stdoutIsTTY: false })).toEqual({
      mode: "help",
      reason: "non-interactive",
    });
  });

  it("prints concise machine-safe fallback copy", () => {
    const output = conciseNonInteractiveHelp();

    expect(output).toContain("Matrix OS CLI");
    expect(output).toContain("matrix tui");
    expect(output).toContain("Direct commands remain script-safe");
  });
});
