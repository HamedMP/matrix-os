import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createFundedRelay } from "../../packages/proxy/src/funded-relay.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";
import { createFundedRelayService, requireFundedRelayServiceConfig } from "../../packages/proxy/src/funded-main-app.js";
import { estimateWorstCaseMicrousd, isFundedModelPriceCurrent, priceActualUsageMicrousd } from "../../packages/proxy/src/funded-relay-model.js";

const reviewedAt = "2026-10-02T00:00:00.000Z";
const validThrough = "2026-10-31T23:59:59.999Z";
const models = [
  { id: "anthropic/claude-sonnet-5", prefix: "SONNET", version: "anthropic-2026-08-31-standard", cost: 6_000 },
  { id: "@cf/zai-org/glm-5.3-flash", prefix: "GLM", version: "cloudflare-2026-09-10-glm-flash", cost: 240 },
] as const;
function env(): NodeJS.ProcessEnv {
  return { MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
    PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: "c".repeat(32), AI_RELAY_METADATA_SECRET: "m".repeat(32) };
}
function reviewEnv(model: typeof models[number]): NodeJS.ProcessEnv {
  return { [`MATRIX_FUNDED_${model.prefix}_PRICING_REVIEW_VERSION`]: model.version,
    [`MATRIX_FUNDED_${model.prefix}_PRICING_REVIEWED_AT`]: reviewedAt,
    [`MATRIX_FUNDED_${model.prefix}_PRICING_VALID_THROUGH`]: validThrough };
}
function reply(model: typeof models[number]): Response {
  return Response.json(model.prefix === "GLM"
    ? { success: true, result: { model: model.id, choices: [{ message: { content: "ok" } }] } }
    : { type: "message", model: "claude-sonnet-5", content: [{ type: "text", text: "ok" }] });
}
describe("generic funded model pricing reviews", () => {
  it.each(models)("requires a separate current review for $prefix readiness and admission", async (model) => {
    const config = requireFundedRelayServiceConfig({ ...env(), ...reviewEnv(model) });
    const now = new Date("2026-10-02T12:00:00.000Z");
    expect(isFundedModelPriceCurrent(model.id, now, config.pricingReviews)).toBe(true);
    expect(estimateWorstCaseMicrousd({ canonicalModelId: model.id, inputTokens: 1_000, maxOutputTokens: 100,
      now, pricingReviews: config.pricingReviews })).toEqual({ amountMicrousd: model.cost, pricingVersion: model.version, pricingValidThrough: validThrough });
    const peer = models.find((item) => item.id !== model.id)!;
    expect(isFundedModelPriceCurrent(peer.id, now, config.pricingReviews)).toBe(false);
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => reply(model));
    const service = createFundedRelayService(config, { now: () => now, fetchFn });
    try {
      const response = await service.app.request(`/ready?model=${encodeURIComponent(model.id)}`, { headers: { authorization: `Bearer ${config.relayControlToken}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ready: true, priceValidThrough: validThrough });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally { await service.close(); }
  });
  it.each(models)("enforces $prefix review boundaries without any late upstream probe", async (model) => {
    const config = requireFundedRelayServiceConfig({ ...env(), ...reviewEnv(model) });
    for (const [time, current] of [[Date.parse(reviewedAt) - 1, false], [Date.parse(reviewedAt), true],
      [Date.parse(validThrough) - 1, true], [Date.parse(validThrough), true], [Date.parse(validThrough) + 1, false], [NaN, false]] as const) {
      const now = new Date(time);
      expect(isFundedModelPriceCurrent(model.id, now, config.pricingReviews)).toBe(current);
      const estimate = () => estimateWorstCaseMicrousd({ canonicalModelId: model.id, inputTokens: 1_000, maxOutputTokens: 100, now, pricingReviews: config.pricingReviews });
      if (current) expect(estimate()).toMatchObject({ pricingValidThrough: validThrough });
      else expect(estimate).toThrow(/pricing/i);
    }
    const fetchFn = vi.fn<typeof fetch>();
    const service = createFundedRelayService(config, { now: () => new Date(Date.parse(validThrough) + 1), fetchFn });
    try {
      expect((await service.app.request(`/ready?model=${encodeURIComponent(model.id)}`, { headers: { authorization: `Bearer ${config.relayControlToken}` } })).status).toBe(503);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });
  it.each(models)("rejects $prefix readiness when its review expires in-flight", async (model) => {
    const config = requireFundedRelayServiceConfig({ ...env(), ...reviewEnv(model) });
    let now = new Date(Date.parse(validThrough) - 1);
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => { now = new Date(Date.parse(validThrough) + 1); return reply(model); });
    const service = createFundedRelayService(config, { now: () => now, fetchFn });
    try {
      const response = await service.app.request(`/ready?model=${encodeURIComponent(model.id)}`, { headers: { authorization: `Bearer ${config.relayControlToken}` } });
      expect(response.status).toBe(503);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally { await service.close(); }
  });
  it.each(models)("keeps missing $prefix reviews expired and rejects malformed deployment attestations", (model) => {
    const prefix = `MATRIX_FUNDED_${model.prefix}_PRICING_`;
    expect(isFundedModelPriceCurrent(model.id, new Date("2026-10-02T12:00:00.000Z"), requireFundedRelayServiceConfig(env()).pricingReviews)).toBe(false);
    for (const overrides of [ { [`${prefix}REVIEW_VERSION`]: "unknown-version" }, { [`${prefix}REVIEWED_AT`]: undefined },
      { [`${prefix}REVIEWED_AT`]: "2026-02-30T00:00:00.000Z" }, { [`${prefix}REVIEWED_AT`]: `${reviewedAt} ` },
      { [`${prefix}VALID_THROUGH`]: reviewedAt }, { [`${prefix}VALID_THROUGH`]: "2026-12-01T00:00:00.000Z" } ]) {
      expect(() => requireFundedRelayServiceConfig({ ...env(), ...reviewEnv(model), ...overrides })).toThrow(/pricing review/i);
    }
  });
  it.each(models)("runs $prefix admission with the reviewed horizon and settles captured rates after expiry", async (model) => {
    const config = requireFundedRelayServiceConfig({ ...env(), ...reviewEnv(model) });
    let now = new Date("2026-10-02T12:00:00.000Z");
    const control = platformControl();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
      // An already-started request may finish beyond the review horizon.
      now = new Date(Date.parse(validThrough) + 1);
      return inferenceReply(model);
    });
    const relay = createFundedRelay({ ...config, now: () => now, fetch: fetchFn, requestIdFactory: () => "request_1",
      platformClient: control as unknown as FundedPlatformClient });
    const app = new Hono(); relay.register(app);
    try {
      const response = await app.request(model.prefix === "GLM" ? "/v1/chat/completions" : "/v1/messages", inferenceRequest(model));
      expect(response.status).toBe(200);
      await response.text();
      expect(control.authorize).toHaveBeenCalledWith(expect.objectContaining({ modelId: model.id, billingMode: "usage" }), expect.any(AbortSignal));
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally { await relay.close(); }
    expect(control.finalize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: "exact", actualCostMicrousd: model.prefix === "GLM" ? 24 : 400 }), expect.any(AbortSignal));
  });
  it.each(models)("releases $prefix admission if the review expires during asynchronous authorization", async (model) => {
    const config = requireFundedRelayServiceConfig({ ...env(), ...reviewEnv(model) });
    let now = new Date(Date.parse(validThrough) - 1);
    const control = platformControl(() => { now = new Date(Date.parse(validThrough) + 1); });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => inferenceReply(model));
    const relay = createFundedRelay({ ...config, now: () => now, fetch: fetchFn, requestIdFactory: () => "request_1",
      platformClient: control as unknown as FundedPlatformClient });
    const app = new Hono(); relay.register(app);
    try {
      const response = await app.request(model.prefix === "GLM" ? "/v1/chat/completions" : "/v1/messages", inferenceRequest(model));
      expect(response.status).toBe(503);
      expect(control.release).toHaveBeenCalledExactlyOnceWith({ reservationId: "reservation_1", tokenId: "credential_123", reason: "pre_upstream_failure" }, expect.any(AbortSignal));
      expect(control.start).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(control.finalize).not.toHaveBeenCalled();
    } finally { await relay.close(); }
  });
  it("settles already admitted historical reservations at their captured immutable rate", () => {
    const usage = { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 100, cacheWrite5mTokens: 100, cacheWrite1hTokens: 100 };
    expect(priceActualUsageMicrousd({ canonicalModelId: models[0].id, pricingVersion: "anthropic-2026-08-29", usage })).toBe(3_670);
    expect(priceActualUsageMicrousd({ canonicalModelId: models[0].id, pricingVersion: models[0].version, usage })).toBe(3_670);
    expect(priceActualUsageMicrousd({ canonicalModelId: models[1].id, pricingVersion: models[1].version, usage })).toBe(233);
    expect(() => priceActualUsageMicrousd({ canonicalModelId: models[1].id, pricingVersion: models[0].version, usage })).toThrow(/version/i);
    expect(() => priceActualUsageMicrousd({ canonicalModelId: models[0].id, pricingVersion: "unknown", usage })).toThrow(/version/i);
  });
});

function platformControl(afterAuthorize?: () => void) {
  const identity = { tokenId: "credential_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "preview", audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-11-01T00:10:00.000Z" };
  return {
    check: vi.fn(async () => ({ identity })),
    authorize: vi.fn(async (input: { requestId: string; modelId: string }) => {
      afterAuthorize?.();
      return { identity, reservation: { reservationId: "reservation_1", requestId: input.requestId, modelId: input.modelId, reservedMicrousd: 1, billingMode: "usage" } };
    }),
    start: vi.fn(async () => ({ reservationId: "reservation_1", requestId: "request_1", tokenId: identity.tokenId })),
    release: vi.fn(async () => ({})), finalize: vi.fn(async () => ({})),
  };
}
function inferenceRequest(model: typeof models[number]): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", "x-api-key": `sk-matrix-funded-credential_123.${"s".repeat(43)}` },
    body: JSON.stringify({ model: model.prefix === "GLM" ? model.id : "claude-sonnet-5", max_tokens: 100, stream: false, messages: [{ role: "user", content: "hi" }] }) };
}
function inferenceReply(model: typeof models[number]): Response {
  return Response.json(model.prefix === "GLM"
    ? { success: true, result: { model: model.id, id: "response_1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 10 } } } }
    : { id: "msg_1", type: "message", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: "text", text: "ok" }] });
}
