// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainTerminalLaunchQueue,
  enqueueTerminalLaunch,
  releaseTerminalLaunchTarget,
  requeueFailedTerminalLaunch,
  requeueTerminalLaunch,
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

  it("requeues failed launches without dispatching an immediate retry event", () => {
    const launchListener = vi.fn();
    window.addEventListener("matrix:terminal-launch", launchListener);

    requeueTerminalLaunch("claude-login", "terminal-a");

    expect(launchListener).not.toHaveBeenCalled();
    expect(drainTerminalLaunchQueue("terminal-a")).toEqual([
      expect.objectContaining({ action: "claude-login", targetId: "terminal-a" }),
    ]);
    window.removeEventListener("matrix:terminal-launch", launchListener);
  });

  it("retargets and wakes a terminal for a failed targeted launch", async () => {
    enqueueTerminalLaunch("claude-login", "terminal-a");
    const [launch] = drainTerminalLaunchQueue("terminal-a");
    const launchListener = vi.fn();
    window.addEventListener("matrix:terminal-launch", launchListener);

    requeueFailedTerminalLaunch(launch!.action, launch!.retryCount, launch!.tabId);
    await Promise.resolve();

    const retried = drainTerminalLaunchQueue("terminal-b");
    expect(retried).toEqual([expect.objectContaining({ action: "claude-login", retryCount: 1 })]);
    expect(retried[0]?.tabId).toBe(launch?.tabId);
    expect(retried[0]).not.toHaveProperty("targetId");
    expect(launchListener).toHaveBeenCalledTimes(1);
    window.removeEventListener("matrix:terminal-launch", launchListener);
  });

  it("retains a failed launch in memory when session storage is unavailable", () => {
    enqueueTerminalLaunch("claude-login", "terminal-a");
    const [launch] = drainTerminalLaunchQueue("terminal-a");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    requeueFailedTerminalLaunch(launch!.action, launch!.retryCount);
    setItem.mockRestore();

    expect(drainTerminalLaunchQueue("terminal-b")).toEqual([
      expect.objectContaining({ action: "claude-login", retryCount: 1 }),
    ]);
  });

  it("preserves unmatched durable launches when a targeted drain cannot be written", () => {
    enqueueTerminalLaunch("claude-login", "terminal-a");
    enqueueTerminalLaunch("codex-login", "terminal-b");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(drainTerminalLaunchQueue("terminal-a")).toEqual([
      expect.objectContaining({ action: "claude-login", targetId: "terminal-a" }),
    ]);
    setItem.mockRestore();

    expect(drainTerminalLaunchQueue("terminal-b")).toEqual([
      expect.objectContaining({ action: "codex-login", targetId: "terminal-b" }),
    ]);
    expect(drainTerminalLaunchQueue()).toEqual([]);
  });

  it("reuses the canonical tab id when a failed drain write is replayed after reload", async () => {
    enqueueTerminalLaunch("claude-login", "terminal-a");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    const [claimed] = drainTerminalLaunchQueue("terminal-a");
    setItem.mockRestore();
    vi.resetModules();
    const reloaded = await import("../../shell/src/lib/terminal-launch.js");
    const [replayed] = reloaded.drainTerminalLaunchQueue("terminal-a");

    expect(replayed?.tabId).toBe(claimed?.tabId);
    expect(replayed?.tabId).toMatch(/^tt_[0-9a-f]{32}$/);
    expect(reloaded.drainTerminalLaunchQueue()).toEqual([]);
  });

  it("does not erase pending launches after a transient session storage read failure", () => {
    enqueueTerminalLaunch("claude-login", "terminal-a");
    vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(drainTerminalLaunchQueue("terminal-a")).toEqual([]);
    expect(sessionStorage.getItem("matrix:terminal-launch-queue")).toContain("claude-login");
    expect(drainTerminalLaunchQueue("terminal-a")).toEqual([
      expect.objectContaining({ action: "claude-login", targetId: "terminal-a" }),
    ]);
  });

  it("stops automatic wake-ups after three failed launch attempts", async () => {
    const launchListener = vi.fn();
    window.addEventListener("matrix:terminal-launch", launchListener);

    requeueFailedTerminalLaunch("claude-login", 3);
    await Promise.resolve();

    expect(launchListener).not.toHaveBeenCalled();
    expect(drainTerminalLaunchQueue()).toEqual([
      expect.objectContaining({ action: "claude-login", retryCount: 3 }),
    ]);
    window.removeEventListener("matrix:terminal-launch", launchListener);
  });

  it("releases queued launches when their target terminal is destroyed", async () => {
    enqueueTerminalLaunch("claude-login", "terminal-a");
    const launchListener = vi.fn();
    window.addEventListener("matrix:terminal-launch", launchListener);

    releaseTerminalLaunchTarget("terminal-a");
    const released = drainTerminalLaunchQueue("terminal-b");
    await Promise.resolve();

    expect(released).toEqual([expect.objectContaining({ action: "claude-login" })]);
    expect(released[0]).not.toHaveProperty("targetId");
    expect(launchListener).toHaveBeenCalledTimes(1);
    window.removeEventListener("matrix:terminal-launch", launchListener);
  });

  it("releases and wakes a queued launch after a transient storage read failure", async () => {
    vi.useFakeTimers();
    enqueueTerminalLaunch("claude-login", "terminal-a");
    const claimed: ReturnType<typeof drainTerminalLaunchQueue> = [];
    const launchListener = vi.fn(() => {
      claimed.push(...drainTerminalLaunchQueue("terminal-b"));
    });
    window.addEventListener("matrix:terminal-launch", launchListener);
    try {
      const originalGetItem = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, "getItem")
        .mockImplementationOnce(() => {
          throw new DOMException("blocked", "SecurityError");
        })
        .mockImplementationOnce(() => {
          throw new DOMException("blocked again", "SecurityError");
        })
        .mockImplementation(function (key) {
          return originalGetItem.call(this, key);
        });

      releaseTerminalLaunchTarget("terminal-a");
      await Promise.resolve();
      expect(claimed).toEqual([]);

      await vi.runOnlyPendingTimersAsync();

      expect(claimed).toEqual([expect.objectContaining({ action: "claude-login" })]);
      expect(claimed[0]).not.toHaveProperty("targetId");
      expect(launchListener).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener("matrix:terminal-launch", launchListener);
      vi.useRealTimers();
    }
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
