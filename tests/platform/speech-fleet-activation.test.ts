import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  activatePlatformSpeechFleet,
  activatePlatformSpeechFleetPages,
} from "../../packages/platform/src/speech/fleet-activation.js";
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
    const secret = "p".repeat(32);
    const runtimeToken = buildPlatformSpeechRuntimeVerificationToken({
      handle: machine.handle,
      machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot,
    }, secret, machine.runtimeTokenEpoch);
    const configurationRevision = createHash("sha256")
      .update(`${machine.machineId}\0${machine.runtimeSlot}\0https://app.matrix-os.com\0${runtimeToken}`)
      .digest("hex");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "restarting" }), { status: 202 }))
      .mockResolvedValueOnce(Response.json({
        configured: true,
        configurationRevision: "f".repeat(64),
      }))
      .mockResolvedValueOnce(Response.json({ configured: true, configurationRevision }));

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
          runtimeToken,
        }),
      }),
    );
  });

  it("processes every bounded machine page without retaining unbounded details", async () => {
    const second = { ...machine, machineId: "machine_456", handle: "bob", publicIPv4: "203.0.113.11" };
    async function* pages() {
      yield [machine];
      yield [second];
    }
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ status: "restarting" }), { status: 202 });
      const posted = JSON.parse(String(fetchImpl.mock.calls.at(-2)?.[1]?.body)) as {
        machineId: string; runtimeSlot: string; origin: string; runtimeToken: string;
      };
      return Response.json({
        configured: true,
        configurationRevision: createHash("sha256")
          .update(`${posted.machineId}\0${posted.runtimeSlot}\0${posted.origin}\0${posted.runtimeToken}`)
          .digest("hex"),
      });
    });

    await expect(activatePlatformSpeechFleetPages({
      pages: pages(),
      platformOrigin: "https://app.matrix-os.com",
      platformSecret: "p".repeat(32),
      fetchImpl,
      wait: async () => undefined,
      verificationAttempts: 1,
      detailLimit: 1,
    })).resolves.toMatchObject({ activated: 2, failed: 0, results: [expect.objectContaining({ machineId: machine.machineId })], detailsTruncated: true });
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
