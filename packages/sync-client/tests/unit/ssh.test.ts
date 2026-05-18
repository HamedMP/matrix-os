import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
}));

import { spawn } from "node:child_process";
import { remoteAttachCommand, resolveTarget, spawnSsh } from "../../src/cli/commands/ssh.js";

describe("resolveTarget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves the authenticated user's VPS target when no handle is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        host: "203.0.113.10",
        port: 22,
        user: "matrix",
        sessionName: "matrix-main",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveTarget({
        platformUrl: "https://app.matrix-os.com",
        token: "token",
      }),
    ).resolves.toEqual({
      host: "203.0.113.10",
      port: 22,
      user: "matrix",
      sessionName: "matrix-main",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/ssh/resolve",
      expect.objectContaining({
        headers: { Authorization: "Bearer token" },
      }),
    );
  });

  it("validates and returns the API-provided SSH target", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        host: "203.0.113.10",
        port: 22,
        user: "matrix",
        sessionName: "matrix-main",
      }),
    });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveTarget({
        handle: "@alice",
        platformUrl: "https://app.matrix-os.com",
        token: "token",
      }),
    ).resolves.toEqual({
      host: "203.0.113.10",
      port: 22,
      user: "matrix",
      sessionName: "matrix-main",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/ssh/resolve?handle=alice",
      expect.objectContaining({
        headers: { Authorization: "Bearer token" },
      }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("rejects invalid SSH targets returned by the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          host: "bad host name",
          port: 70_000,
          user: "root!",
        }),
      }),
    );

    await expect(
      resolveTarget({
        handle: "@alice",
        platformUrl: "https://app.matrix-os.com",
        token: "token",
      }),
    ).rejects.toThrow("Platform returned an invalid SSH target");
  });

  it("uses interactive host key checking and attaches the Matrix session for spawned SSH sessions", () => {
    spawnSsh({
      host: "203.0.113.10",
      port: 22,
      user: "matrix",
      sessionName: "matrix-main",
    });

    expect(spawn).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining([
        "-p",
        "22",
        "-o",
        "StrictHostKeyChecking=ask",
        "-t",
        "matrix@203.0.113.10",
        expect.stringContaining("zellij attach matrix-main"),
      ]),
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("opens a raw SSH login without a remote attach command", () => {
    spawnSsh({
      host: "203.0.113.10",
      port: 22,
      user: "matrix",
      sessionName: "matrix-main",
    }, { raw: true });

    expect(spawn).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "-o", "StrictHostKeyChecking=ask", "matrix@203.0.113.10"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("falls back from zellij to tmux and then to a login shell", () => {
    expect(remoteAttachCommand("matrix-main")).toContain("zellij attach matrix-main");
    expect(remoteAttachCommand("matrix-main")).toContain("tmux attach -t matrix-main");
    expect(remoteAttachCommand("matrix-main")).toContain('exec "${SHELL:-/bin/bash}" -l');
  });
});
