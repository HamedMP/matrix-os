import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createFundedPlatformClient, FundedControlPlaneError } from "../../packages/proxy/src/funded-relay-platform-client.js";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";

const config = () => resolveFundedRelayConfig({
  MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
  CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "gateway-test-token-1234567890123456789",
  CLOUDFLARE_WORKERS_AI_TOKEN: "workers-test-token-1234567890123456789",
  PLATFORM_INTERNAL_URL: "https://platform.example.com", AI_RELAY_CONTROL_TOKEN: "relay-test-token-12345678901234567890",
  AI_RELAY_METADATA_SECRET: "metadata-test-secret-1234567890123456",
})!;
const messages = { insufficient_credit: "Not enough Matrix AI credit", budget_exceeded: "Monthly AI budget reached" };

describe("funded control-plane credit failures", () => {
  it.each([[402, "insufficient_credit"], [403, "budget_exceeded"]] as const)("preserves trusted %s/%s through Relay without inference or retry", async (status, code) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: { code, message: messages[code] } }, { status }));
    const client = createFundedPlatformClient({ ...config(), fetch: fetchImpl });
    await expect(client.authorize({ credential: "private-runtime-token", requestId: "request_1", modelId: "@cf/zai-org/glm-5.3-flash", maxCostMicrousd: 1 }, new AbortController().signal))
      .rejects.toMatchObject({ status, fundingReason: code });
    fetchImpl.mockClear();
    const upstream = vi.fn<typeof fetch>();
    const relay = createFundedRelay({ ...config(), fetch: upstream, platformClient: client, now: () => new Date("2026-09-10T12:00:00Z") });
    const app = new Hono(); relay.register(app);
    try {
      const response = await app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer sk-matrix-funded-credential_123.${"s".repeat(43)}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "@cf/zai-org/glm-5.3-flash", stream: true, messages: [{ role: "user", content: "hello" }] }) });
      expect(response.status).toBe(403);
      expect(response.headers.get("x-matrix-funded-error")).toBe(code);
      expect(response.headers.has("x-matrix-funded-reason")).toBe(false);
      expect(await response.text()).not.toContain("private-runtime-token");
      expect(upstream).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { await relay.close(); }
  });
  it.each([
    [402, { error: { code: "insufficient_credit", message: "secret provider /tmp/private" } }],
    [401, { error: { code: "insufficient_credit", message: messages.insufficient_credit } }],
    [403, { error: { code: "insufficient_credit", message: messages.insufficient_credit } }],
    [402, { error: { code: "budget_exceeded", message: messages.budget_exceeded } }],
    [403, { error: { code: "access_disabled", message: "Matrix-funded AI is unavailable" } }],
    [402, "not JSON"], [502, { error: { code: "budget_exceeded", message: messages.budget_exceeded } }],
  ])("drops unknown/malformed/status-mismatched credit reasons", async (status, body) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => typeof body === "string" ? new Response(body, { status: status as number }) : Response.json(body, { status: status as number }));
    const client = createFundedPlatformClient({ ...config(), fetch: fetchImpl });
    await expect(client.check({ credential: "token", modelId: "@cf/zai-org/glm-5.3-flash" }, new AbortController().signal))
      .rejects.toMatchObject({ name: "FundedControlPlaneError", fundingReason: undefined });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("retains priority reasons independently of credit failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "rate_limited", message: "Try again later", reason: "slot_busy" } }, { status: 429 }));
    const client = createFundedPlatformClient({ ...config(), fetch: fetchImpl });
    await expect(client.check({ credential: "token", modelId: "@cf/zai-org/glm-5.3-flash" }, new AbortController().signal))
      .rejects.toEqual(new FundedControlPlaneError(429, "slot_busy"));
  });
});
