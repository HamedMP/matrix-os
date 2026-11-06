import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { FundedControlPlaneError, type FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const CREDENTIAL = `sk-matrix-funded-token_123.${"s".repeat(43)}`;
const IDENTITY = { tokenId: "token_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "dev",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T13:00:00.000Z" };
const relays: ReturnType<typeof createFundedRelay>[] = [];
function setup(options: { mode?: "usage" | "cloudflare-count"; countStatus?: number; checkStatus?: number; response?: () => Response; maxBodyBytes?: number } = {}) {
  const config = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: options.mode ?? "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-gateway-token-123456789012345",
    PLATFORM_INTERNAL_URL: "https://platform.example.com", AI_RELAY_CONTROL_TOKEN: "relay-control-token-1234567890123456789",
    AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890123" })!;
  const control = {
    check: vi.fn(async () => { if (options.checkStatus) throw new FundedControlPlaneError(options.checkStatus); return { identity: IDENTITY }; }),
    authorize: vi.fn(async (request: { requestId: string; modelId: string; maxCostMicrousd: number }) => ({ identity: IDENTITY,
      reservation: { reservationId: "reservation_123", requestId: request.requestId, modelId: request.modelId,
        reservedMicrousd: 0, billingMode: "usage", billingPolicy: "postpaid", maxCostMicrousd: request.maxCostMicrousd } })),
    start: vi.fn(async (request: { executionId: string }) => ({ ...request, contractVersion: 1, status: "in_flight",
      startedAt: NOW.toISOString(), expiresAt: "2026-09-10T12:10:00.000Z", reservationId: "reservation_123", requestId: "request_123", tokenId: IDENTITY.tokenId })),
    release: vi.fn(async () => ({})), terminal: vi.fn(async () => ({})), finalize: vi.fn(async () => ({})),
  };
  const count = vi.fn(async () => options.countStatus === 200 ? Response.json({ input_tokens: 37 })
    : Response.json({ type: "error", error: { type: "authentication_error", message: "private provider authentication detail" } }, { status: options.countStatus ?? 401 }));
  const generation = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("input_tokens");
    return options.response?.() ?? Response.json({ type: "message", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 2 } });
  });
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith("/v1/messages/count_tokens") ? count() : generation(String(url), init));
  const relay = createFundedRelay({ ...config, ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}),
    fetch: fetchMock, now: () => NOW, requestIdFactory: () => "request_123", platformClient: control as unknown as FundedPlatformClient });
  relays.push(relay); const app = new Hono(); relay.register(app);
  const request = (path = "/v1/messages", body: unknown = { model: "claude-sonnet-5", messages: [{ role: "user", content: "hello" }], max_tokens: 256 }) => app.request(path, {
    method: "POST", headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { request, count, generation, control };
}
afterEach(async () => { await Promise.all(relays.splice(0).map(relay => relay.close())); vi.restoreAllMocks(); });

describe("funded generation token preflight", () => {
  it("generates usage-mode requests despite unavailable provider counting and settles only actual usage", async () => {
    const { request, count, generation, control } = setup();
    const response = await request();
    expect(response.status).toBe(200); await response.text();
    expect(count).not.toHaveBeenCalled(); expect(generation).toHaveBeenCalledOnce();
    expect(control.authorize).toHaveBeenCalledWith(expect.objectContaining({ billingMode: "usage", billingPolicy: "postpaid", maxCostMicrousd: 4_803_072 }), expect.any(AbortSignal));
    await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith({ reservationId: "reservation_123", tokenId: IDENTITY.tokenId,
      mode: "exact", actualCostMicrousd: 40 }, expect.any(AbortSignal)));
    expect(control.terminal).not.toHaveBeenCalled();
  });

  it("keeps legacy cloudflare-count generation closed on a real count failure", async () => {
    const { request, count, generation, control } = setup({ mode: "cloudflare-count" });
    const response = await request(); expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private provider");
    expect(count).toHaveBeenCalledOnce(); expect(generation).not.toHaveBeenCalled();
    expect(control.authorize).not.toHaveBeenCalled(); expect(control.start).not.toHaveBeenCalled();
  });

  it.each(["usage", "cloudflare-count"] as const)("returns only real explicit counts and honest count failures in %s mode", async mode => {
    const success = setup({ mode, countStatus: 200 });
    const response = await success.request("/v1/messages/count_tokens");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ input_tokens: 37 });
    const denied = setup({ mode }); expect((await denied.request("/v1/messages/count_tokens")).status).toBe(502);
    for (const target of [success, denied]) {
      expect(target.count).toHaveBeenCalledOnce(); expect(target.generation).not.toHaveBeenCalled();
      expect(target.control.authorize).not.toHaveBeenCalled(); expect(target.control.start).not.toHaveBeenCalled();
    }
  });

  it.each([401, 403])("rejects policy/auth status %i before any provider dispatch", async checkStatus => {
    const { request, count, generation, control } = setup({ checkStatus });
    expect((await request()).status).toBe(checkStatus);
    expect(count).not.toHaveBeenCalled(); expect(generation).not.toHaveBeenCalled(); expect(control.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid schema", { maxBodyBytes: 1024 }, { model: "claude-sonnet-5", messages: [], max_tokens: 256 }, 400],
    ["oversized body", { maxBodyBytes: 1024 }, { model: "claude-sonnet-5", messages: [{ role: "user", content: "x".repeat(2048) }], max_tokens: 256 }, 413],
  ] as const)("rejects %s before policy or provider dispatch", async (_name, config, body, status) => {
    const { request, count, generation, control } = setup(config);
    expect((await request("/v1/messages", body)).status).toBe(status);
    expect(count).not.toHaveBeenCalled(); expect(generation).not.toHaveBeenCalled(); expect(control.check).not.toHaveBeenCalled();
  });

  it("waives customer charge on a known zero-usage generation rejection", async () => {
    const { request, count, control } = setup({ response: () => Response.json({ type: "error",
      error: { type: "rate_limit_error", message: "Limited" }, request_id: "req_123" }, { status: 429 }) });
    expect((await request()).status).toBe(429); expect(count).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith({ reservationId: "reservation_123", tokenId: IDENTITY.tokenId,
      mode: "exact", actualCostMicrousd: 0, customerCharge: "waived" }, expect.any(AbortSignal)));
  });

  it("retains unknown usage as unknown with zero monetary hold", async () => {
    const { request, count, control } = setup({ response: () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) });
    const response = await request(); expect(response.status).toBe(200); await response.text();
    expect(count).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(control.terminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "usage_unknown" }), expect.any(AbortSignal)));
    expect(control.finalize).not.toHaveBeenCalled();
  });

  it("does not turn cancelled generation into a fabricated exact charge", async () => {
    const cancelled = vi.fn();
    const { request, count, control } = setup({ response: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10}}}\n\n')); },
      cancel: cancelled,
    }), { headers: { "content-type": "text/event-stream" } }) });
    const response = await request(); expect(response.status).toBe(200); await response.body!.cancel("client disconnected");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
    await vi.waitFor(() => expect(control.terminal).toHaveBeenCalled());
    expect(control.finalize).not.toHaveBeenCalled(); expect(count).not.toHaveBeenCalled();
  });
});
