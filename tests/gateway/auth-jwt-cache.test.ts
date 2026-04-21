import { afterEach, describe, expect, it, vi } from "vitest";

describe("readJwtKeyConfig", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("jose");
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
});
