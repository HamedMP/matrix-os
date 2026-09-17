import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopEnrollmentInputSchema,
  DesktopReauthorizationInputSchema,
  performDesktopEnrollment,
  performDesktopReauthorization,
  readDesktopEnrollmentInput,
} from "../../src/auth/desktop-enrollment.js";

const INPUT = DesktopEnrollmentInputSchema.parse({
  schemaVersion: 1,
  profile: "desktop",
  platformUrl: "https://app.matrix-os.com",
  gatewayUrl: "https://app.matrix-os.com",
  desktopAccessToken: "desktop-bearer-secret",
  deviceName: "Alice Mac",
  localRoot: "/Users/alice/matrixos/studio",
  remotePrefix: "",
  direction: "two_way",
  expectedIdentity: {
    userId: "user_alice",
    handle: "alice",
    runtimeSlot: "studio",
  },
});

const CREDENTIAL = {
  accessToken: "sync-access-secret",
  refreshToken: `sdr_18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c.${"a".repeat(43)}`,
  expiresAt: 1_800_000_000_000,
  userId: "user_alice",
  handle: "alice",
  runtimeSlot: "studio",
};

const OLD_CREDENTIAL = {
  ...CREDENTIAL,
  accessToken: "old-sync-access-secret",
  refreshToken: `sdr_28e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c.${"b".repeat(43)}`,
};

describe("Desktop helper enrollment", () => {
  it("accepts one bounded JSON object from stdin", async () => {
    const stream = Readable.from([JSON.stringify(INPUT)]);
    await expect(readDesktopEnrollmentInput(stream)).resolves.toEqual(INPUT);

    const oversized = Readable.from(["x".repeat(32 * 1024 + 1)]);
    await expect(readDesktopEnrollmentInput(oversized)).rejects.toThrow("desktop_enrollment_input_too_large");
  });

  it("persists a renewable credential and mapping without returning secrets", async () => {
    const enroll = vi.fn(async () => CREDENTIAL);
    const saveCredential = vi.fn(async () => undefined);
    const saveProfile = vi.fn(async () => undefined);
    const saveLegacyConfig = vi.fn(async () => undefined);
    const saveMappingConfig = vi.fn(async () => undefined);
    const installAndStart = vi.fn(async () => undefined);

    const result = await performDesktopEnrollment(INPUT, {
      enroll,
      saveCredential,
      saveProfile,
      loadLegacyConfig: vi.fn(async () => null),
      saveLegacyConfig,
      loadMappingConfig: vi.fn(async () => null),
      saveMappingConfig,
      installAndStart,
      randomId: () => "11111111-1111-4111-8111-111111111111",
    });

    expect(enroll).toHaveBeenCalledWith(expect.objectContaining({
      desktopAccessToken: INPUT.desktopAccessToken,
      expected: INPUT.expectedIdentity,
    }));
    expect(saveCredential).toHaveBeenCalledWith(INPUT.profile, CREDENTIAL);
    expect(saveProfile).toHaveBeenCalledWith(INPUT.profile, {
      platformUrl: INPUT.platformUrl,
      gatewayUrl: INPUT.gatewayUrl,
    });
    expect(saveMappingConfig).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: -1,
      config: expect.objectContaining({
        ownerId: INPUT.expectedIdentity.userId,
        runtimeSlot: INPUT.expectedIdentity.runtimeSlot,
        mappings: [expect.objectContaining({
          id: "11111111-1111-4111-8111-111111111111",
          localRoot: INPUT.localRoot,
          remotePrefix: "",
        })],
      }),
    }));
    expect(installAndStart).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(INPUT.desktopAccessToken);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL.accessToken);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL.refreshToken);
  });

  it("revokes a newly issued grant when local credential persistence fails", async () => {
    const revoke = vi.fn(async () => undefined);
    await expect(performDesktopEnrollment(INPUT, {
      enroll: vi.fn(async () => CREDENTIAL),
      revoke,
      saveCredential: vi.fn(async () => { throw new Error("disk full"); }),
      saveProfile: vi.fn(async () => undefined),
      loadLegacyConfig: vi.fn(async () => null),
      saveLegacyConfig: vi.fn(async () => undefined),
      loadMappingConfig: vi.fn(async () => null),
      saveMappingConfig: vi.fn(async () => undefined),
      installAndStart: vi.fn(async () => undefined),
      randomId: () => "11111111-1111-4111-8111-111111111111",
    })).rejects.toThrow("disk full");
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ auth: CREDENTIAL }));
  });

  it("renews the Desktop grant without mutating existing mappings", async () => {
    const input = DesktopReauthorizationInputSchema.parse({
      schemaVersion: 1,
      profile: "desktop",
      platformUrl: INPUT.platformUrl,
      desktopAccessToken: INPUT.desktopAccessToken,
      deviceName: INPUT.deviceName,
      expectedIdentity: INPUT.expectedIdentity,
    });
    const enroll = vi.fn(async () => CREDENTIAL);
    const saveCredential = vi.fn(async () => undefined);
    const loadCredential = vi.fn(async () => OLD_CREDENTIAL);
    const revoke = vi.fn(async () => undefined);
    const installAndStart = vi.fn(async () => undefined);

    await expect(performDesktopReauthorization(input, {
      enroll,
      loadCredential,
      saveCredential,
      revoke,
      installAndStart,
    })).resolves.toEqual({ ok: true, profile: "desktop" });
    expect(enroll).toHaveBeenCalledWith(expect.objectContaining({
      desktopAccessToken: INPUT.desktopAccessToken,
      expected: INPUT.expectedIdentity,
    }));
    expect(saveCredential).toHaveBeenCalledWith("desktop", CREDENTIAL);
    expect(loadCredential).toHaveBeenCalledWith("desktop");
    expect(revoke).toHaveBeenCalledWith({
      platformUrl: INPUT.platformUrl,
      auth: OLD_CREDENTIAL,
    });
    expect(installAndStart).toHaveBeenCalledOnce();
  });
});
