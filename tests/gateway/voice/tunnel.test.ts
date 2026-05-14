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
    it("returns the shared app domain", async () => {
      const url = await tunnel.start({ provider: "cloudflare", localPort: 4000 });

      expect(url).toBe("https://app.matrix-os.com");
    });

    it("uses MATRIX_PUBLIC_APP_URL when configured", async () => {
      vi.stubEnv("MATRIX_PUBLIC_APP_URL", "https://app.localhost:3000");

      const url = await tunnel.start({ provider: "cloudflare", localPort: 4000 });

      expect(url).toBe("https://app.localhost:3000");
    });
  });

  describe("health", () => {
    it("returns true for the managed app domain", async () => {
      expect(await tunnel.health()).toBe(true);
    });
  });

  describe("stop", () => {
    it("completes without error", async () => {
      await expect(tunnel.stop()).resolves.not.toThrow();
    });
  });
});
