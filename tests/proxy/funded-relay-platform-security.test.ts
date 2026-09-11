import { describe, expect, it, vi } from "vitest";
import { resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay-config.js";
import { createFundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const GATEWAY_URL =
  "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix/anthropic";
const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);
const SECRET_C = "c".repeat(32);

function enabledEnv(platformBaseUrl: string): NodeJS.ProcessEnv {
  return {
    MATRIX_FUNDED_AI_ENABLED: "1",
    CLOUDFLARE_AI_GATEWAY_URL: GATEWAY_URL,
    CLOUDFLARE_AI_GATEWAY_TOKEN: SECRET_A,
    PLATFORM_INTERNAL_URL: platformBaseUrl,
    AI_RELAY_CONTROL_TOKEN: SECRET_B,
    AI_RELAY_METADATA_SECRET: SECRET_C,
  };
}

function clientOptions(platformBaseUrl: string, fetchImpl = vi.fn() as unknown as typeof fetch) {
  return {
    platformBaseUrl,
    relayControlToken: SECRET_B,
    platformTimeoutMs: 5_000,
    maxControlResponseBytes: 64 * 1024,
    fetch: fetchImpl,
  };
}

describe("funded relay platform transport security", () => {
  it.each([
    ["remote HTTPS", "https://platform.matrix-os.com", "https://platform.matrix-os.com"],
    ["canonical IPv4 loopback HTTP", "http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
    ["canonical IPv6 loopback HTTP", "http://[::1]:8787", "http://[::1]:8787"],
  ])("accepts %s", (_label, input, expected) => {
    expect(resolveFundedRelayConfig(enabledEnv(input))?.platformBaseUrl).toBe(expected);
    expect(() => createFundedPlatformClient(clientOptions(input))).not.toThrow();
  });

  it.each([
    ["remote host", "http://platform.matrix-os.com"],
    ["localhost hostname", "http://localhost:8787"],
    ["private IPv4", "http://10.0.0.1:8787"],
    ["adjacent IPv4", "http://127.0.0.2:8787"],
    ["localhost suffix", "http://localhost.example.com:8787"],
    ["localhost trailing dot", "http://localhost.:8787"],
    ["short IPv4 alias", "http://127.1:8787"],
    ["integer IPv4 alias", "http://2130706433:8787"],
    ["hex IPv4 alias", "http://0x7f000001:8787"],
    ["octal IPv4 alias", "http://0177.0.0.1:8787"],
    ["expanded IPv6 alias", "http://[0:0:0:0:0:0:0:1]:8787"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]:8787"],
    ["HTTPS userinfo", "https://relay:secret@platform.matrix-os.com"],
    ["loopback userinfo", "http://relay:secret@localhost:8787"],
    ["query", "https://platform.matrix-os.com?target=http://example.com"],
    ["empty query", "https://platform.matrix-os.com?"],
    ["fragment", "https://platform.matrix-os.com#control"],
    ["control path", "https://platform.matrix-os.com/internal"],
    ["double-slash path", "https://platform.matrix-os.com//internal"],
    ["normalized traversal path", "https://platform.matrix-os.com/%2e%2e"],
    ["backslash authority", String.raw`http:\\platform.matrix-os.com`],
  ])("rejects %s without creating a credential-bearing client", (_label, input) => {
    const fetchMock = vi.fn();
    expect(() => resolveFundedRelayConfig(enabledEnv(input))).toThrow(/HTTPS|origin/i);
    expect(() => createFundedPlatformClient(clientOptions(input, fetchMock as typeof fetch)))
      .toThrow(/HTTPS|origin/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("snapshots the validated origin and relay bearer before accepting runtime credentials", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://platform.matrix-os.com/internal/ai/funded/check");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SECRET_B}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        credential: "runtime-credential",
        modelId: "anthropic/claude-sonnet-5",
      });
      throw new Error("test stop");
    });
    const options = clientOptions("https://platform.matrix-os.com", fetchMock as typeof fetch);
    const client = createFundedPlatformClient(options);

    options.platformBaseUrl = "http://platform.matrix-os.com";
    options.relayControlToken = "mutated-plaintext-bearer";

    await expect(client.check({
      credential: "runtime-credential",
      modelId: "anthropic/claude-sonnet-5",
    }, new AbortController().signal)).rejects.toThrow("test stop");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
