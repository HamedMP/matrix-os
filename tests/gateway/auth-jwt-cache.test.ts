import { afterEach, describe, expect, it, vi } from "vitest";

describe("readJwtKeyConfig", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("jose");
    vi.useRealTimers();
  });

  it("retries RS256 key import after a cached rejection", async () => {
    const importSPKI = vi.fn().mockRejectedValue(new Error("bad pem"));

    vi.doMock("jose", async () => {
      const actual = await vi.importActual<typeof import("jose")>("jose");
      return {
        ...actual,
        importSPKI,
      };
    });

    const { readJwtKeyConfig } = await import("../../packages/gateway/src/auth-jwt.js");
    const env = { PLATFORM_JWT_PUBLIC_KEY: "not-a-valid-pem" } as NodeJS.ProcessEnv;

    await expect(readJwtKeyConfig(env)).rejects.toThrow("bad pem");
    await expect(readJwtKeyConfig(env)).rejects.toThrow("bad pem");
    expect(importSPKI).toHaveBeenCalledTimes(2);
  });

  it("refreshes the cached RS256 key after the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T10:00:00Z"));
    const keyA = {} as CryptoKey;
    const keyB = {} as CryptoKey;
    const importSPKI = vi
      .fn()
      .mockResolvedValueOnce(keyA)
      .mockResolvedValueOnce(keyB);

    vi.doMock("jose", async () => {
      const actual = await vi.importActual<typeof import("jose")>("jose");
      return {
        ...actual,
        importSPKI,
      };
    });

    const { readJwtKeyConfig } = await import("../../packages/gateway/src/auth-jwt.js");
    const env = {
      PLATFORM_JWT_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    } as NodeJS.ProcessEnv;

    await expect(readJwtKeyConfig(env)).resolves.toEqual({ publicKey: keyA });
    await expect(readJwtKeyConfig(env)).resolves.toEqual({ publicKey: keyA });
    expect(importSPKI).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-04-22T10:05:01Z"));

    await expect(readJwtKeyConfig(env)).resolves.toEqual({ publicKey: keyB });
    expect(importSPKI).toHaveBeenCalledTimes(2);
  });
});
