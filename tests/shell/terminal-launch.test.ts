// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalSessionLaunchPath,
  createTerminalLaunchPath,
  drainTerminalLaunchQueue,
  enqueueTerminalLaunch,
  parseTerminalSessionLaunchPath,
  parseTerminalLaunchPath,
  TERMINAL_SETUP_WINDOW_PATH,
} from "../../shell/src/lib/terminal-launch.js";

describe("terminal launch paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("maps onboarding setup actions to startup commands", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_779_788_800_000);

    expect(parseTerminalLaunchPath(createTerminalLaunchPath("claude-login"))).toMatchObject({
      label: "Claude login",
      command: "claude",
      claudeMode: true,
    });
    expect(parseTerminalLaunchPath(createTerminalLaunchPath("codex-login"))).toMatchObject({
      label: "Codex login",
      command: "codex",
    });
    const githubLogin = parseTerminalLaunchPath(createTerminalLaunchPath("github-ssh-login"));
    expect(githubLogin?.label).toBe("GitHub browser login");
    expect(githubLogin?.command).toContain("gh auth login --hostname github.com --web");
    expect(githubLogin?.command).toContain("Matrix-managed key");
    expect(githubLogin?.command).not.toContain("--git-protocol ssh");
  });

  it("ignores ordinary terminal paths", () => {
    expect(parseTerminalLaunchPath("__terminal__")).toBeNull();
    expect(parseTerminalLaunchPath("__terminal__:random")).toBeNull();
  });

  it("targets setup actions at the canonical terminal surface", () => {
    expect(TERMINAL_SETUP_WINDOW_PATH).toBe("__terminal__");
  });

  it("round-trips workspace terminal session launch paths", () => {
    expect(parseTerminalSessionLaunchPath(createTerminalSessionLaunchPath("term_abc123"))).toBe("term_abc123");
    expect(parseTerminalSessionLaunchPath(createTerminalSessionLaunchPath("550e8400-e29b-41d4-a716-446655440000"))).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(createTerminalSessionLaunchPath("term_owner_abc123")).toBe("__terminal__:session-term_owner_abc123");
  });

  it("keeps workspace session launch paths distinct from setup launch paths", () => {
    const setupPath = createTerminalLaunchPath("codex-login");

    expect(parseTerminalSessionLaunchPath("__terminal__")).toBeNull();
    expect(parseTerminalSessionLaunchPath("__terminal__:random")).toBeNull();
    expect(parseTerminalSessionLaunchPath("__terminal__:session-")).toBeNull();
    expect(parseTerminalSessionLaunchPath(setupPath)).toBeNull();
    expect(parseTerminalLaunchPath(createTerminalSessionLaunchPath("term_abc123"))).toBeNull();
  });

  it("queues setup actions so an existing terminal can open them as tabs", () => {
    enqueueTerminalLaunch(createTerminalLaunchPath("claude-login"));
    enqueueTerminalLaunch(createTerminalLaunchPath("codex-login"));

    expect(drainTerminalLaunchQueue().map((launch) => launch.action)).toEqual([
      "claude-login",
      "codex-login",
    ]);
    expect(drainTerminalLaunchQueue()).toEqual([]);
  });

  it("drains only launches targeted at the active terminal window", () => {
    enqueueTerminalLaunch(createTerminalLaunchPath("claude-login"), "terminal-a");
    enqueueTerminalLaunch(createTerminalLaunchPath("codex-login"), "terminal-b");
    enqueueTerminalLaunch(createTerminalLaunchPath("github-ssh-login"));

    expect(drainTerminalLaunchQueue("terminal-a").map((launch) => launch.action)).toEqual([
      "claude-login",
      "github-ssh-login",
    ]);
    expect(drainTerminalLaunchQueue("terminal-b").map((launch) => launch.action)).toEqual([
      "codex-login",
    ]);
    expect(drainTerminalLaunchQueue()).toEqual([]);
  });
});
