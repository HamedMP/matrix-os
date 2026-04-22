import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
}));

import { spawn } from "node:child_process";
import { resolveTarget, spawnSsh } from "../../src/cli/commands/ssh.js";

describe("resolveTarget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns the default SSH target when no handle is provided", async () => {
    await expect(
      resolveTarget({
        gatewayUrl: "https://matrix-os.com",
        token: "token",
      }),
    ).resolves.toEqual({
      host: "ssh.matrix-os.com",
      port: 2222,
      user: "matrixos",
    });
  });

  it("validates and returns the API-provided SSH target", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        host: "ssh.matrix-os.com",
        port: 2222,
        user: "matrixos",
      }),
    });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveTarget({
        handle: "@alice",
        gatewayUrl: "https://gateway.matrix-os.com",
        token: "token",
      }),
    ).resolves.toEqual({
      host: "ssh.matrix-os.com",
      port: 2222,
      user: "matrixos",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.matrix-os.com/api/ssh/resolve?handle=alice",
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
        gatewayUrl: "https://gateway.matrix-os.com",
        token: "token",
      }),
    ).rejects.toThrow("Platform returned an invalid SSH target");
  });

  it("uses interactive host key checking for spawned SSH sessions", () => {
    spawnSsh({
      host: "ssh.matrix-os.com",
      port: 2222,
      user: "matrixos",
    });

    expect(spawn).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-o", "StrictHostKeyChecking=ask"]),
      expect.objectContaining({ stdio: "inherit" }),
    );
  });
});
