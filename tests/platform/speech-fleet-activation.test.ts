import { describe, expect, it, vi } from "vitest";
import { activatePlatformSpeechFleet } from "../../packages/platform/src/speech/fleet-activation.js";
import { buildPlatformSpeechRuntimeVerificationToken, buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";

const machine = {
  machineId: "machine_123",
  clerkUserId: "user_alice",
  handle: "alice",
  runtimeSlot: "primary",
  runtimeTokenEpoch: 1,
  publicIPv4: "203.0.113.10",
};

describe("platform speech fleet activation", () => {
  it("installs a machine-bound speech token and verifies the restarted gateway", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "restarting" }), { status: 202 }))
      .mockResolvedValueOnce(Response.json({ configured: false }))
      .mockResolvedValueOnce(Response.json({ configured: true }));
    const secret = "p".repeat(32);

    await expect(activatePlatformSpeechFleet({
      machines: [machine],
      platformOrigin: "https://app.matrix-os.com",
      platformSecret: secret,
      fetchImpl,
      wait: async () => undefined,
      verificationAttempts: 2,
    })).resolves.toEqual({ activated: 1, failed: 0, results: [{
      machineId: machine.machineId,
      handle: machine.handle,
      status: "activated",
    }] });

    expect(fetchImpl).toHaveBeenNthCalledWith(1,
      "https://203.0.113.10:443/api/internal/platform-speech/config",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, secret)}`,
        }),
        body: JSON.stringify({
          machineId: machine.machineId,
          runtimeSlot: machine.runtimeSlot,
          enabled: true,
          origin: "https://app.matrix-os.com",
          runtimeToken: buildPlatformSpeechRuntimeVerificationToken({
            handle: machine.handle,
            machineId: machine.machineId,
            runtimeSlot: machine.runtimeSlot,
          }, secret, machine.runtimeTokenEpoch),
        }),
      }),
    );
  });

  it("reports old or unreachable hosts without exposing response bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("private details", { status: 404 }));
    await expect(activatePlatformSpeechFleet({
      machines: [machine],
      platformOrigin: "https://app.matrix-os.com",
      platformSecret: "p".repeat(32),
      fetchImpl,
      wait: async () => undefined,
      verificationAttempts: 1,
    })).resolves.toEqual({
      activated: 0,
      failed: 1,
      results: [{ machineId: machine.machineId, handle: machine.handle, status: "failed", error: "HTTP 404" }],
    });
  });
});
