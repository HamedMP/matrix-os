import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { mapFundedModel, priceActualUsageMicrousd } from "../../packages/proxy/src/funded-relay-model.js";
import { createFundedUsageTracker } from "../../packages/proxy/src/funded-relay-usage.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const MODEL = "@cf/zai-org/glm-5.3-flash";
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const NOW = new Date("2026-09-10T12:00:00Z");
const IDENTITY = {
  tokenId: "credential_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "preview",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T12:15:00Z",
};
function config() {
  return resolveFundedRelayConfig({
    MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-gateway-token-123456789012345",
    CLOUDFLARE_WORKERS_AI_TOKEN: "cloudflare-workers-ai-token-123456789012345",
    PLATFORM_INTERNAL_URL: "https://platform.example.com",
    AI_RELAY_CONTROL_TOKEN: "relay-control-token-1234567890123456789",
    AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890123",
  })!;
}
function usage(cached = 10) {
  return { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: cached } };
}
function sse(duplicate = false) {
  const chunk = (value: unknown) => `data: ${JSON.stringify({ id: "response_1", model: MODEL, ...value as object })}\n\n`;
  const final = chunk({ choices: [], usage: usage() });
  return chunk({ choices: [{ index: 0, delta: { reasoning_content: "Thinking" }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tool_1", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    + final + (duplicate ? final : "") + "data: [DONE]\n\n";
}
function tracker() {
  return createFundedUsageTracker({ contentType: "text/event-stream", nativeModelId: MODEL,
    canonicalModelId: MODEL, pricingVersion: "cloudflare-2026-09-10-glm-flash", maxCaptureBytes: 10_000 });
}
function platform() {
  return {
    check: vi.fn(async () => ({ identity: IDENTITY })),
    authorize: vi.fn(async (input: { requestId: string; modelId: string }) => ({
      identity: IDENTITY, reservation: { reservationId: "reservation_1", requestId: input.requestId,
        modelId: input.modelId, reservedMicrousd: 1, billingMode: "usage" },
    })),
    start: vi.fn(async () => ({ reservationId: "reservation_1", requestId: "request_1", tokenId: IDENTITY.tokenId })),
    release: vi.fn(), finalize: vi.fn(async () => ({})),
  };
}
describe("Cloudflare GLM usage relay", () => {
  it("maps only the exact managed GLM ID and prices fractional cached tokens without rounding rates", () => {
    expect(mapFundedModel(MODEL)).toMatchObject({ nativeModelId: MODEL, canonicalModelId: MODEL });
    expect(() => mapFundedModel("@cf/unreviewed/model")).toThrow();
    expect(priceActualUsageMicrousd({ canonicalModelId: MODEL, pricingVersion: "cloudflare-2026-09-10-glm-flash",
      usage: { inputTokens: 90, outputTokens: 20, cacheReadTokens: 10, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
    })).toBe(24);
  });
  it("accepts usage admission and rejects the superseded full-context mode", () => {
    expect(config().reservationMode).toBe("usage");
    expect(() => resolveFundedRelayConfig({ ...process.env, MATRIX_FUNDED_AI_ENABLED: "1",
      MATRIX_FUNDED_AI_RESERVATION_MODE: "model-context" })).toThrow();
  });
  it.each([false, true])("settles a complete tool/reasoning stream exactly once (duplicate=%s)", (duplicate) => {
    const capture = tracker();
    const bytes = new TextEncoder().encode(sse(duplicate));
    for (let offset = 0; offset < bytes.length; offset += 7) capture.push(bytes.slice(offset, offset + 7));
    expect(capture.complete()).toEqual({ mode: "exact", actualCostMicrousd: 24 });
    expect(capture.complete()).toEqual({ mode: "conservative" });
  });
  it.each([
    "data: [DONE]\n\n",
    sse().replace('"cached_tokens":10', '"cached_tokens":101'),
    sse().replace('"total_tokens":120', '"total_tokens":119'),
    sse().replace("data: [DONE]\n\n", ""),
    sse().replace('"model":"@cf/zai-org/glm-5.3-flash"', '"model":"untrusted"'),
  ])("leaves missing or inconsistent usage unresolved", (body) => {
    const capture = tracker(); capture.push(new TextEncoder().encode(body));
    expect(capture.complete()).toEqual({ mode: "conservative" });
  });
  it("uses only the fixed prepaid Workers AI route, skips counting, and settles above the affordable hold", async () => {
    const control = platform();
    const rawSse = sse().replace(`data: ${JSON.stringify({ id: "response_1", model: MODEL, choices: [], usage: usage() })}`,
      `data: ${JSON.stringify({ response: "", usage: usage() })}`);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(rawSse, {
      headers: { "content-type": "text/event-stream" },
    }));
    const relay = createFundedRelay({ ...config(), fetch: fetchMock, now: () => NOW,
      requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient });
    const app = new Hono(); relay.register(app);
    const response = await app.request("/v1/chat/completions", { method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json",
        "cf-aig-gateway-id": "attacker", "cf-aig-metadata": "attacker" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 256 }),
    });
    expect(response.status).toBe(200); expect(await response.text()).toContain('"usage"'); await relay.close();
    expect(control.authorize).toHaveBeenCalledWith(expect.objectContaining({ billingMode: "usage", modelId: MODEL }), expect.any(AbortSignal));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/${MODEL}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${config().workersAiToken}`);
    expect(headers.get("cf-aig-gateway-id")).toBe("preview");
    expect(headers.get("cf-aig-metadata")).not.toContain("attacker");
    expect(headers.has("x-api-key")).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream_options: { include_usage: true } });
    expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init?.redirect).toBe("error");
    expect(control.finalize).toHaveBeenCalledWith({ reservationId: "reservation_1", tokenId: IDENTITY.tokenId,
      mode: "exact", actualCostMicrousd: 24 }, expect.any(AbortSignal));
  });
  it.each([
    { model: "@cf/unreviewed/model" }, { max_tokens: 128_001 }, { user: "caller-authority" },
    { webhookUrl: "http://127.0.0.1" }, { n: 2 }, { messages: [{ role: "tool", content: "bad" }] },
  ])("denies unsupported requests before inference", async (override) => {
    const control = platform(); const fetchMock = vi.fn();
    const relay = createFundedRelay({ ...config(), fetch: fetchMock, now: () => NOW,
      platformClient: control as unknown as FundedPlatformClient });
    const app = new Hono(); relay.register(app);
    const response = await app.request("/v1/chat/completions", { method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, ...override }),
    });
    expect([400, 403]).toContain(response.status); expect(fetchMock).not.toHaveBeenCalled();
    expect(control.authorize).not.toHaveBeenCalled(); await relay.close();
  });
});
