// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalLaunchPath,
  drainTerminalLaunchQueue,
  enqueueTerminalLaunch,
  parseTerminalLaunchPath,
} from "../../shell/src/lib/terminal-launch.js";

describe("terminal launch paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("maps onboarding setup actions to startup commands", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_779_788_800_000);

    expect(parseTerminalLaunchPath(createTerminalLaunchPath("agent-claude"))).toMatchObject({
      label: "Claude Code setup",
      command: "claude",
      claudeMode: true,
    });
    expect(parseTerminalLaunchPath(createTerminalLaunchPath("agent-codex"))).toMatchObject({
      label: "Codex setup",
      command: "codex",
    });
    expect(parseTerminalLaunchPath(createTerminalLaunchPath("agent-opencode"))).toMatchObject({
      label: "OpenCode setup",
      command: "opencode",
    });
    expect(parseTerminalLaunchPath(createTerminalLaunchPath("agent-gemini"))).toMatchObject({
      label: "Gemini CLI setup",
      command: "gemini",
    });
    expect(parseTerminalLaunchPath(createTerminalLaunchPath("agent-shell"))).toMatchObject({
      label: "Shell setup",
      command: "bash",
    });
    expect(parseTerminalLaunchPath(createTerminalLaunchPath("github-ssh-login"))?.command).toContain("gh auth login --hostname github.com --git-protocol ssh --web");
  });

  it("ignores ordinary terminal paths", () => {
    expect(parseTerminalLaunchPath("__terminal__")).toBeNull();
    expect(parseTerminalLaunchPath("__terminal__:random")).toBeNull();
  });

  it("queues setup actions so an existing terminal can open them as tabs", () => {
    enqueueTerminalLaunch(createTerminalLaunchPath("agent-claude"));
    enqueueTerminalLaunch(createTerminalLaunchPath("agent-codex"));

    expect(drainTerminalLaunchQueue().map((launch) => launch.action)).toEqual([
      "agent-claude",
      "agent-codex",
    ]);
    expect(drainTerminalLaunchQueue()).toEqual([]);
  });

  it("drains only launches targeted at the active terminal window", () => {
    enqueueTerminalLaunch(createTerminalLaunchPath("agent-claude"), "terminal-a");
    enqueueTerminalLaunch(createTerminalLaunchPath("agent-codex"), "terminal-b");
    enqueueTerminalLaunch(createTerminalLaunchPath("github-ssh-login"));

    expect(drainTerminalLaunchQueue("terminal-a").map((launch) => launch.action)).toEqual([
      "agent-claude",
      "github-ssh-login",
    ]);
    expect(drainTerminalLaunchQueue("terminal-b").map((launch) => launch.action)).toEqual([
      "agent-codex",
    ]);
    expect(drainTerminalLaunchQueue()).toEqual([]);
  });
});
