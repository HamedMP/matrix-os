import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  activatePlatformSpeechFleet,
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

describe('already-working speech on a pinned platform origin', () => {
  const capabilities = {
    contractVersion: 1,
    fileTranscription: {
      status: 'ready',
      dictation: { enabled: true, maxBytes: 10485760, maxDurationMs: 120000, maxTranscriptChars: 32000, supportedMediaTypes: ['audio/wav'], languageHints: false },
      ownerAudio: { enabled: false },
    },
  };

  it('accepts ready speech only after verifying the exact runtime identity when reconfiguration is rejected', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('Invalid request', { status: 400 }))
      .mockResolvedValueOnce(Response.json({ runtime: { handle: machine.handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot } }))
      .mockResolvedValueOnce(Response.json(capabilities));
    const result = await activatePlatformSpeechFleet({ machines: [machine], platformOrigin: 'https://api.matrix-os.com', platformSecret: 'p'.repeat(32), fetchImpl });
    expect(result).toMatchObject({ activated: 1, failed: 0 });
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['https://203.0.113.10:443/api/internal/platform-speech/config', 'POST'],
      ['https://203.0.113.10:443/api/system/info', 'GET'],
      ['https://203.0.113.10:443/api/speech/capabilities', 'GET'],
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each(['handle', 'machineId', 'runtimeSlot'])('rejects a different %s before requesting speech readiness', async (field) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('Invalid request', { status: 400 }))
      .mockResolvedValueOnce(Response.json({ runtime: { handle: machine.handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot, [field]: 'another' } }));
    const result = await activatePlatformSpeechFleet({ machines: [machine], platformOrigin: 'https://api.matrix-os.com', platformSecret: 'p'.repeat(32), fetchImpl });
    expect(result).toMatchObject({ activated: 0, failed: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['disabled', { ...capabilities, fileTranscription: { ...capabilities.fileTranscription, status: 'unavailable', reason: 'disabled' } }],
    ['malformed', { ready: true }],
    ['dictation disabled', { ...capabilities, fileTranscription: { ...capabilities.fileTranscription, dictation: { ...capabilities.fileTranscription.dictation, enabled: false } } }],
  ])('does not accept %s capability data as working speech', async (_label, payload) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('Invalid request', { status: 400 }))
      .mockResolvedValueOnce(Response.json({ runtime: { handle: machine.handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot } }))
      .mockResolvedValueOnce(Response.json(payload));
    const result = await activatePlatformSpeechFleet({ machines: [machine], platformOrigin: 'https://api.matrix-os.com', platformSecret: 'p'.repeat(32), fetchImpl });
    expect(result).toMatchObject({ activated: 0, failed: 1 });
  });
});
