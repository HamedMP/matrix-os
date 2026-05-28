import { describe, expect, it } from "vitest";
import { isScriptableDirectInvocation, resolveTuiLaunchMode } from "../../src/cli/tui/launch.js";

describe("direct command compatibility", () => {
  it("bypasses TUI for existing explicit commands", () => {
    for (const argv of [["login"], ["logout"], ["sync", "status"], ["peers"], ["shell", "ls"], ["sh", "ls"], ["profile", "show"], ["whoami"], ["status"], ["run", "-it", "--", "claude"], ["doctor"], ["instance", "info"], ["completion"]]) {
      expect(resolveTuiLaunchMode({ argv, stdinIsTTY: true, stdoutIsTTY: true }).mode, argv.join(" ")).toBe("direct");
      expect(isScriptableDirectInvocation(argv), argv.join(" ")).toBe(true);
    }
  });

  it("keeps help, version, and json invocations scriptable", () => {
    for (const argv of [["--help"], ["help"], ["--version"], ["status", "--json"], ["--json"]]) {
      expect(resolveTuiLaunchMode({ argv, stdinIsTTY: true, stdoutIsTTY: true }).mode, argv.join(" ")).toBe("direct");
      expect(isScriptableDirectInvocation(argv), argv.join(" ")).toBe(true);
    }
  });

  it("treats direct tui help invocations as scriptable", () => {
    const argv = ["tui", "--help"];

    expect(resolveTuiLaunchMode({ argv, stdinIsTTY: true, stdoutIsTTY: true }).mode).toBe("direct");
    expect(isScriptableDirectInvocation(argv)).toBe(true);
  });

});
