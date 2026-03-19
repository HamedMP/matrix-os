import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CloudflareTunnel } from "../../../packages/gateway/src/voice/tunnel/cloudflare.js";
import type { TunnelProvider } from "../../../packages/gateway/src/voice/tunnel/base.js";

describe("voice/tunnel/cloudflare", () => {
  let tunnel: CloudflareTunnel;

  beforeEach(() => {
    tunnel = new CloudflareTunnel();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("implements TunnelProvider interface", () => {
    const provider: TunnelProvider = tunnel;
    expect(provider.name).toBe("cloudflare");
    expect(typeof provider.start).toBe("function");
    expect(typeof provider.stop).toBe("function");
    expect(typeof provider.health).toBe("function");
  });

  describe("start", () => {
    it("returns correct URL with handle", async () => {
      vi.stubEnv("MATRIX_HANDLE", "alice");

      const url = await tunnel.start({ provider: "cloudflare", localPort: 4000 });

      expect(url).toBe("https://alice.matrix-os.com");
    });

    it("falls back to 'dev' handle when MATRIX_HANDLE not set", async () => {
      vi.stubEnv("MATRIX_HANDLE", "");

      const url = await tunnel.start({ provider: "cloudflare", localPort: 4000 });

      expect(url).toBe("https://dev.matrix-os.com");
    });
  });

  describe("health", () => {
    it("returns true when MATRIX_HANDLE is set", async () => {
      vi.stubEnv("MATRIX_HANDLE", "alice");

      expect(await tunnel.health()).toBe(true);
    });

    it("returns false when no handle", async () => {
      vi.stubEnv("MATRIX_HANDLE", "");

      expect(await tunnel.health()).toBe(false);
    });
  });

  describe("stop", () => {
    it("completes without error", async () => {
      await expect(tunnel.stop()).resolves.not.toThrow();
    });
  });
});
