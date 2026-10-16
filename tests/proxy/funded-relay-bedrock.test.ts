import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  BedrockUpstreamError,
} from "../../packages/proxy/src/funded-bedrock-upstream.js";
import { resolveBedrockRouteConfig } from "../../packages/proxy/src/funded-bedrock-route.js";
import { createFundedRelay } from "../../packages/proxy/src/funded-relay.js";
import { FUNDED_GLM_FLASH } from "../../packages/proxy/src/funded-relay-model.js";
import { createFundedRelayService } from "../../packages/proxy/src/funded-main-app.js";
import { resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay-config.js";
import type { FundedGenerationUpstream } from "../../packages/proxy/src/funded-relay-upstream.js";
import { FUNDED_PRICING_VERSIONS } from "../../packages/proxy/src/funded-pricing-review.js";
import { FundedControlPlaneError, type FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const NOW = new Date("2026-10-13T10:00:00.000Z");
const MODEL = "matrix-bedrock-qualified";
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const IDENTITY = { tokenId: "credential_123", ownerId: "owner_123", machineId: "machine_123",
  runtimeSlot: "preview", audience: "matrix-funded-relay", scope: "ai:invoke",
  expiresAt: "2026-10-13T10:15:00.000Z" };
const SELECTION = { upstream: "aws_bedrock" as const, preferenceRevision: 1,
  checkedAt: NOW.toISOString(), staleAfter: "2026-10-13T10:00:30.000Z", proof: "a".repeat(64) };
const ROUTE = resolveBedrockRouteConfig({ MATRIX_FUNDED_BEDROCK_ROUTE: JSON.stringify({
  routeId: "bedrock-eu-primary", region: "eu-west-1", clientModelId: MODEL,
  canonicalModelId: "bedrock/qualified-model", resolvedModel: "qualified-model",
  inferenceProfile: "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/qualified-model",
  maxInputTokens: 200_000, maxOutputTokens: 8_192,
  pricing: { version: "aws-bedrock-qualified-2026-10-13", reviewedAt: "2026-10-13T09:00:00.000Z",
    validThrough: "2026-10-20T23:59:59.999Z", inputRateHundredths: 100,
    outputRateHundredths: 500, cacheReadRateHundredths: 10,
    cacheWrite5mRateHundredths: 125, cacheWrite1hRateHundredths: 200 },
}) })!;

function config() {
  return resolveFundedRelayConfig({
    MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    MATRIX_FUNDED_GLM_PRICING_REVIEW_VERSION: FUNDED_PRICING_VERSIONS[FUNDED_GLM_FLASH],
    MATRIX_FUNDED_GLM_PRICING_REVIEWED_AT: "2026-10-01T00:00:00.000Z",
    MATRIX_FUNDED_GLM_PRICING_VALID_THROUGH: "2026-10-31T00:00:00.000Z",
    MATRIX_FUNDED_BEDROCK_ROUTE: JSON.stringify(ROUTE),
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-gateway-token-123456789012345",
    CLOUDFLARE_WORKERS_AI_TOKEN: "cloudflare-workers-ai-token-123456789012345",
    PLATFORM_INTERNAL_URL: "https://platform.example.com",
    AI_RELAY_CONTROL_TOKEN: "relay-control-token-1234567890123456789",
    AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890123",
  })!;
}

function platform() {
  return {
    check: vi.fn(async () => ({ identity: IDENTITY, upstreamSelectionVersion: 1 as const,
      upstreamSelection: SELECTION })),
    authorize: vi.fn(async (input: { requestId: string; modelId: string; maxCostMicrousd: number }) => ({
      identity: IDENTITY, reservation: { reservationId: "reservation_1", requestId: input.requestId,
        modelId: input.modelId, reservedMicrousd: Math.min(1_000, input.maxCostMicrousd),
        maxCostMicrousd: input.maxCostMicrousd, billingMode: "usage", upstream: "aws_bedrock" },
    })),
    start: vi.fn(async () => ({ reservationId: "reservation_1", requestId: "request_1", tokenId: IDENTITY.tokenId })),
    release: vi.fn(), finalize: vi.fn(async () => ({})),
  };
}

function response(): Response {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(chunk({ id: "response_1", model: MODEL,
    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })
    + chunk({ id: "response_1", model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    + chunk({ id: "response_1", model: MODEL, choices: [], usage: {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 10, cache_write_5m_tokens: 5, cache_write_1h_tokens: 5 },
    } }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

function workersResponse(): Response {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(chunk({ id: "response_1", model: FUNDED_GLM_FLASH,
    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })
    + chunk({ response: "ok", usage: {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    } }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

function request() {
  return new Request("https://relay.example/v1/chat/completions", { method: "POST",
    headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }],
      max_tokens: 20, stream: true }) });
}

describe("funded Bedrock relay", () => {
  it("reports readiness only after a bounded route probe with current pricing", async () => {
    const bedrockUpstream: FundedGenerationUpstream = {
      dispatch: vi.fn(async () => ({ response: response(), provenance: {
        upstream: "aws_bedrock", routeId: ROUTE.routeId, resolvedModel: ROUTE.resolvedModel,
        inferenceProfile: ROUTE.inferenceProfile, region: ROUTE.region,
        pricingVersion: ROUTE.pricing.version, providerRequestId: "aws-readiness-1",
      } })), close: vi.fn(),
    };
    const service = createFundedRelayService(config(), { now: () => NOW, bedrockUpstream });
    const ready = await service.app.request(`/ready?model=${encodeURIComponent(MODEL)}&upstream=aws_bedrock`, {
      headers: { authorization: `Bearer ${config().relayControlToken}` },
    });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true, priceValidThrough: ROUTE.pricing.validThrough });
    expect(bedrockUpstream.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ model: MODEL, max_tokens: 1 }),
      signal: expect.any(AbortSignal),
    }));
    await service.close();
  });

  it("fails an explicit Bedrock readiness request closed instead of probing Cloudflare", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ ready: true }));
    const service = createFundedRelayService(config(), { now: () => NOW, fetchFn });
    const ready = await service.app.request(
      `/ready?model=${encodeURIComponent(FUNDED_GLM_FLASH)}&upstream=aws_bedrock`,
      { headers: { authorization: `Bearer ${config().relayControlToken}` } },
    );
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false });
    expect(fetchFn).not.toHaveBeenCalled();
    await service.close();
  });

  it("checks policy, reserves, starts, dispatches, and settles exact route-bound usage", async () => {
    const control = platform();
    const order: string[] = [];
    control.check.mockImplementation(async () => { order.push("check"); return {
      identity: IDENTITY, upstreamSelectionVersion: 1 as const, upstreamSelection: SELECTION,
    }; });
    control.authorize.mockImplementation(async (input) => { order.push("authorize"); return {
      identity: IDENTITY, reservation: { reservationId: "reservation_1", requestId: input.requestId,
        modelId: input.modelId, reservedMicrousd: 1_000, maxCostMicrousd: input.maxCostMicrousd,
        billingMode: "usage" as const, upstream: "aws_bedrock" as const },
    }; });
    control.start.mockImplementation(async () => { order.push("start"); return {
      reservationId: "reservation_1", requestId: "request_1", tokenId: IDENTITY.tokenId,
    }; });
    const bedrockUpstream: FundedGenerationUpstream = {
      dispatch: vi.fn(async () => { order.push("dispatch"); return { response: response(), provenance: {
        upstream: "aws_bedrock", routeId: ROUTE.routeId, resolvedModel: ROUTE.resolvedModel,
        inferenceProfile: ROUTE.inferenceProfile, region: ROUTE.region,
        pricingVersion: ROUTE.pricing.version, providerRequestId: "aws-request-1",
      } }; }),
      close: vi.fn(),
    };
    const fetchMock = vi.fn();
    const relay = createFundedRelay({ ...config(), fetch: fetchMock, now: () => NOW,
      requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient,
      bedrockUpstream });
    const app = new Hono(); relay.register(app);
    const result = await app.fetch(request());
    expect(result.status).toBe(200);
    expect(await result.text()).toContain('"content":"ok"');
    expect(order).toEqual(["check", "authorize", "start", "dispatch"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(control.check).toHaveBeenCalledWith(expect.objectContaining({ modelId: ROUTE.canonicalModelId }), expect.any(AbortSignal));
    expect(control.authorize).toHaveBeenCalledWith(expect.objectContaining({ upstream: "aws_bedrock",
      upstreamSelection: SELECTION }), expect.any(AbortSignal));
    expect(control.finalize).toHaveBeenCalledWith({ reservationId: "reservation_1", tokenId: IDENTITY.tokenId,
      mode: "exact", actualCostMicrousd: 198, upstreamProvenance: expect.objectContaining({
        upstream: "aws_bedrock", providerRequestId: "aws-request-1",
      }) }, expect.any(AbortSignal));
    await relay.close();
    expect(bedrockUpstream.close).toHaveBeenCalledOnce();
  });

  it("rejects a conservatively oversized Bedrock input before reservation or start", async () => {
    const control = platform();
    const bedrockUpstream: FundedGenerationUpstream = { dispatch: vi.fn(), close: vi.fn() };
    const relay = createFundedRelay({ ...config(), bedrockRoute: { ...ROUTE, maxInputTokens: 1_000 },
      now: () => NOW, requestIdFactory: () => "request_1",
      platformClient: control as unknown as FundedPlatformClient, bedrockUpstream });
    const app = new Hono(); relay.register(app);
    const result = await app.fetch(new Request("https://relay.example/v1/chat/completions", { method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "x".repeat(5_000) }],
        max_tokens: 20, stream: true }) }));
    expect(result.status).toBe(400);
    expect(control.authorize).not.toHaveBeenCalled();
    expect(control.start).not.toHaveBeenCalled();
    expect(bedrockUpstream.dispatch).not.toHaveBeenCalled();
    await relay.close();
  });

  it.each([
    { reasoning_effort: "high" },
    { parallel_tool_calls: false },
  ])("rejects untranslated Bedrock controls before reservation or start: %j", async (override) => {
    const control = platform();
    const bedrockUpstream: FundedGenerationUpstream = { dispatch: vi.fn(), close: vi.fn() };
    const relay = createFundedRelay({ ...config(), now: () => NOW,
      platformClient: control as unknown as FundedPlatformClient, bedrockUpstream });
    const app = new Hono(); relay.register(app);
    const result = await app.fetch(new Request("https://relay.example/v1/chat/completions", { method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }],
        max_tokens: 20, stream: true, ...override }) }));
    expect(result.status).toBe(400);
    expect(control.authorize).not.toHaveBeenCalled();
    expect(control.start).not.toHaveBeenCalled();
    expect(bedrockUpstream.dispatch).not.toHaveBeenCalled();
    await relay.close();
  });

  it("rejects tool-disabled Bedrock follow-ups with tool history before reservation or start", async () => {
    const control = platform();
    const bedrockUpstream: FundedGenerationUpstream = { dispatch: vi.fn(), close: vi.fn() };
    const relay = createFundedRelay({ ...config(), now: () => NOW,
      platformClient: control as unknown as FundedPlatformClient, bedrockUpstream });
    const app = new Hono(); relay.register(app);
    const result = await app.fetch(new Request("https://relay.example/v1/chat/completions", { method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [
        { role: "user", content: "Check the weather." },
        { role: "assistant", content: null, tool_calls: [{ id: "tool_1", type: "function",
          function: { name: "weather", arguments: '{"city":"Rome"}' } }] },
        { role: "tool", tool_call_id: "tool_1", content: '{"temperature":21}' },
        { role: "user", content: "Summarize without calling tools." },
      ], tools: [{ type: "function", function: { name: "weather",
        parameters: { type: "object" } } }], tool_choice: "none", max_tokens: 20, stream: true }) }));
    expect(result.status).toBe(400);
    expect(control.authorize).not.toHaveBeenCalled();
    expect(control.start).not.toHaveBeenCalled();
    expect(bedrockUpstream.dispatch).not.toHaveBeenCalled();
    await relay.close();
  });

  it("never settles exact usage or falls back when the Bedrock stream fails", async () => {
    const control = platform();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode('data: {"id":"response_1","model":"matrix-bedrock-qualified","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
          return;
        }
        controller.error(new BedrockUpstreamError("invalid_response"));
      },
    });
    const bedrockUpstream: FundedGenerationUpstream = {
      dispatch: vi.fn(async () => ({ response: new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }), provenance: {
        upstream: "aws_bedrock", routeId: ROUTE.routeId, resolvedModel: ROUTE.resolvedModel,
        inferenceProfile: ROUTE.inferenceProfile, region: ROUTE.region,
        pricingVersion: ROUTE.pricing.version, providerRequestId: "aws-stream-failure",
      } })), close: vi.fn(),
    };
    const fetchMock = vi.fn();
    const relay = createFundedRelay({ ...config(), fetch: fetchMock, now: () => NOW,
      requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient,
      bedrockUpstream });
    const app = new Hono(); relay.register(app);
    const result = await app.fetch(request());
    expect(result.status).toBe(200);
    await expect(result.text()).rejects.toThrow("AI response stream failed");
    await vi.waitFor(() => expect(control.finalize).toHaveBeenCalled());
    expect(control.finalize).not.toHaveBeenCalledWith(expect.objectContaining({ mode: "exact" }), expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("does not dispatch or fall back when policy rejects the model", async () => {
    const control = platform();
    control.check.mockRejectedValue(new FundedControlPlaneError(403));
    const bedrockUpstream: FundedGenerationUpstream = { dispatch: vi.fn(), close: vi.fn() };
    const fetchMock = vi.fn();
    const relay = createFundedRelay({ ...config(), fetch: fetchMock, now: () => NOW,
      platformClient: control as unknown as FundedPlatformClient, bedrockUpstream });
    const app = new Hono(); relay.register(app);
    expect((await app.fetch(request())).status).toBe(403);
    expect(bedrockUpstream.dispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("rejects Bedrock-only request options before reservation and start", async () => {
    const control = platform();
    const bedrockUpstream: FundedGenerationUpstream = { dispatch: vi.fn(), close: vi.fn() };
    const relay = createFundedRelay({ ...config(), now: () => NOW,
      platformClient: control as unknown as FundedPlatformClient, bedrockUpstream });
    const app = new Hono(); relay.register(app);
    const result = await app.fetch(new Request("https://relay.example/v1/chat/completions", { method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }],
        max_tokens: 20, stream: true, seed: 1 }) }));
    expect(result.status).toBe(400);
    expect(control.authorize).not.toHaveBeenCalled();
    expect(control.start).not.toHaveBeenCalled();
    expect(bedrockUpstream.dispatch).not.toHaveBeenCalled();
    await relay.close();
  });

  it("preserves Cloudflare routing by refusing the Bedrock-only client model without a platform selection", async () => {
    const control = platform();
    control.check.mockResolvedValue({ identity: IDENTITY });
    const bedrockUpstream: FundedGenerationUpstream = { dispatch: vi.fn(), close: vi.fn() };
    const fetchMock = vi.fn();
    const relay = createFundedRelay({ ...config(), fetch: fetchMock, now: () => NOW,
      platformClient: control as unknown as FundedPlatformClient, bedrockUpstream });
    const app = new Hono(); relay.register(app);
    expect((await app.fetch(request())).status).toBe(403);
    expect(control.authorize).not.toHaveBeenCalled();
    expect(bedrockUpstream.dispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("does not enable Bedrock from an unnegotiated selection returned to a legacy check", async () => {
    const control = platform();
    control.check.mockResolvedValue({ identity: IDENTITY, upstreamSelection: SELECTION });
    const bedrockUpstream: FundedGenerationUpstream = { dispatch: vi.fn(), close: vi.fn() };
    const relay = createFundedRelay({ ...config(), fetch: vi.fn(), now: () => NOW,
      platformClient: control as unknown as FundedPlatformClient, bedrockUpstream });
    const app = new Hono(); relay.register(app);

    expect((await app.fetch(request())).status).toBe(403);
    expect(control.authorize).not.toHaveBeenCalled();
    expect(bedrockUpstream.dispatch).not.toHaveBeenCalled();
    await relay.close();
  });

  it("keeps the existing Cloudflare route when an unhealthy preference resolves to Cloudflare", async () => {
    const control = platform();
    control.check.mockResolvedValue({ identity: IDENTITY });
    control.authorize.mockImplementation(async input => ({ identity: IDENTITY, reservation: {
      reservationId: "reservation_1", requestId: input.requestId, modelId: FUNDED_GLM_FLASH,
      reservedMicrousd: 1_000, maxCostMicrousd: input.maxCostMicrousd, billingMode: "usage" as const,
    } }));
    const bedrockUpstream: FundedGenerationUpstream = { dispatch: vi.fn(), close: vi.fn() };
    const fetchMock = vi.fn(async () => workersResponse());
    const relay = createFundedRelay({ ...config(), bedrockRoute: { ...ROUTE,
      clientModelId: FUNDED_GLM_FLASH, canonicalModelId: FUNDED_GLM_FLASH }, fetch: fetchMock, now: () => NOW,
      requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient, bedrockUpstream });
    const app = new Hono(); relay.register(app);
    const result = await app.fetch(new Request("https://relay.example/v1/chat/completions", { method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ model: FUNDED_GLM_FLASH, messages: [{ role: "user", content: "hi" }],
        max_tokens: 20, stream: true }) }));
    expect(result.status).toBe(200);
    await result.text();
    expect(control.authorize).toHaveBeenCalledWith(expect.not.objectContaining({ upstream: expect.anything() }),
      expect.any(AbortSignal));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bedrockUpstream.dispatch).not.toHaveBeenCalled();
    await relay.close();
  });

  it("settles a confirmed pre-stream Bedrock throttle at exact zero and never falls back", async () => {
    const control = platform();
    const bedrockUpstream: FundedGenerationUpstream = {
      dispatch: vi.fn(async () => { throw new BedrockUpstreamError("throttled"); }), close: vi.fn(),
    };
    const fetchMock = vi.fn();
    const relay = createFundedRelay({ ...config(), fetch: fetchMock, now: () => NOW,
      requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient,
      bedrockUpstream });
    const app = new Hono(); relay.register(app);
    const result = await app.fetch(request());
    expect(result.status).toBe(429);
    expect(await result.text()).not.toContain("Bedrock");
    await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith({
      reservationId: "reservation_1", tokenId: IDENTITY.tokenId,
      mode: "exact", actualCostMicrousd: 0,
      upstreamProvenance: {
        upstream: "aws_bedrock", routeId: ROUTE.routeId, resolvedModel: ROUTE.resolvedModel,
        inferenceProfile: ROUTE.inferenceProfile, region: ROUTE.region,
        pricingVersion: ROUTE.pricing.version,
      },
    }, expect.any(AbortSignal)));
    expect(control.finalize).not.toHaveBeenCalledWith(expect.objectContaining({ mode: "conservative" }),
      expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });
});
