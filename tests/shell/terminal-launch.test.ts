// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainTerminalLaunchQueue,
  enqueueTerminalLaunch,
  terminalLaunchConfig,
} from "../../shell/src/lib/terminal-launch.js";

describe("terminal launch paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("maps onboarding setup actions to startup commands", () => {
    expect(terminalLaunchConfig("claude-login")).toMatchObject({
      label: "Claude login",
      command: "claude",
      claudeMode: true,
    });
    expect(terminalLaunchConfig("codex-login")).toMatchObject({
      label: "Codex login",
      command: "codex",
    });
    const githubLogin = terminalLaunchConfig("github-ssh-login");
    expect(githubLogin?.label).toBe("GitHub browser login");
    expect(githubLogin?.command).toContain("gh auth login --hostname github.com --web");
    expect(githubLogin?.command).toContain("Matrix-managed key");
    expect(githubLogin?.command).not.toContain("--git-protocol ssh");
    expect(terminalLaunchConfig("openclaw-model-auth")).toMatchObject({
      action: "openclaw-model-auth",
      command: "openclaw models auth add",
    });
  });

  it("maps runtime installs to the validated host control without sudo", () => {
    expect(terminalLaunchConfig("hermes-install")).toMatchObject({
      action: "hermes-install",
      command: "/opt/matrix/bin/matrix-agent-runtime-control install hermes",
    });
    expect(terminalLaunchConfig("openclaw-install")).toMatchObject({
      action: "openclaw-install",
      command: "/opt/matrix/bin/matrix-agent-runtime-control install openclaw",
    });
    expect(terminalLaunchConfig("openclaw-install").command).not.toContain("sudo");
    expect(terminalLaunchConfig("hermes-restart")).toMatchObject({
      action: "hermes-restart",
      label: "Restart Hermes",
      command: "/opt/matrix/bin/matrix-agent-runtime-control switch hermes",
    });
    expect(terminalLaunchConfig("openclaw-restart")).toMatchObject({
      action: "openclaw-restart",
      label: "Restart OpenClaw",
      command: "/opt/matrix/bin/matrix-agent-runtime-control switch openclaw",
    });
  });

  it("queues setup actions so an existing terminal can open them as tabs", () => {
    enqueueTerminalLaunch("claude-login");
    enqueueTerminalLaunch("codex-login");

    expect(drainTerminalLaunchQueue().map((launch) => launch.action)).toEqual([
      "claude-login",
      "codex-login",
    ]);
    expect(drainTerminalLaunchQueue()).toEqual([]);
  });

  it("drains only launches targeted at the active terminal window", () => {
    enqueueTerminalLaunch("claude-login", "terminal-a");
    enqueueTerminalLaunch("codex-login", "terminal-b");
    enqueueTerminalLaunch("github-ssh-login");

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
