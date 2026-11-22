import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createFundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";

const config = () => resolveFundedRelayConfig({
  MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
  CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "gateway-test-token-1234567890123456789",
  CLOUDFLARE_WORKERS_AI_TOKEN: "workers-test-token-1234567890123456789",
  PLATFORM_INTERNAL_URL: "https://platform.example.com", AI_RELAY_CONTROL_TOKEN: "relay-test-token-12345678901234567890",
  AI_RELAY_METADATA_SECRET: "metadata-test-secret-1234567890123456",
})!;
const RETRY_AT = "2026-09-11T00:00:00.000Z";
const BUSY = { error: { code: "busy", message: "Matrix AI is busy; try again later", retryAt: RETRY_AT } };

async function relayResponse(platform: () => Response): Promise<{ response: Response; upstream: ReturnType<typeof vi.fn> }> {
  const client = createFundedPlatformClient({ ...config(), fetch: vi.fn<typeof fetch>(async () => platform()) });
  const upstream = vi.fn<typeof fetch>();
  const relay = createFundedRelay({ ...config(), fetch: upstream, platformClient: client, now: () => new Date("2026-09-10T12:00:00Z") });
  const app = new Hono();
  relay.register(app);
  try {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer sk-matrix-funded-credential_123.${"s".repeat(43)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "@cf/zai-org/glm-5.3-flash", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    return { response, upstream };
  } finally {
    await relay.close();
  }
}

describe("funded relay busy refusals", () => {
  it("passes the platform's busy refusal through with Retry-After and retryAt", async () => {
    const { response, upstream } = await relayResponse(() => Response.json(BUSY, { status: 503, headers: { "retry-after": "43200" } }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("43200");
    expect(await response.json()).toEqual({
      type: "error", error: { type: "api_error", code: "busy", message: "Matrix AI is busy; try again later", retryAt: RETRY_AT },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["an unavailable 503", () => Response.json({ error: { code: "unavailable", message: "Matrix-funded AI is unavailable" } }, { status: 503 })],
    ["busy without Retry-After", () => Response.json(BUSY, { status: 503 })],
    ["busy with an invalid Retry-After", () => Response.json(BUSY, { status: 503, headers: { "retry-after": "soon" } })],
    ["busy with an invalid retryAt", () => Response.json({ error: { ...BUSY.error, retryAt: "/tmp/private" } }, { status: 503, headers: { "retry-after": "60" } })],
    ["busy on a 500", () => Response.json(BUSY, { status: 500, headers: { "retry-after": "60" } })],
  ])("keeps %s generic", async (_label, platform) => {
    const { response } = await relayResponse(platform);
    expect(response.status).toBe(503);
    expect(response.headers.has("retry-after")).toBe(false);
    expect(await response.json()).toEqual({ type: "error", error: { type: "api_error", message: "AI access is temporarily unavailable" } });
  });
});
