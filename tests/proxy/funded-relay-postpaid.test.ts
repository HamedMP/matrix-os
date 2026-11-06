import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const CREDENTIAL = `sk-matrix-funded-token_123.${"s".repeat(43)}`;
const IDENTITY = { tokenId: "token_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "primary",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T13:00:00.000Z" };
const relays: ReturnType<typeof createFundedRelay>[] = [];

function setup(input: { rejection?: boolean; unknown?: boolean; authorization?: object } = {}) {
  const config = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true",
    // A legacy deployment setting cannot opt customers back into monetary holds.
    MATRIX_FUNDED_AI_RESERVATION_MODE: "cloudflare-count",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-gateway-token-123456789012345",
    CLOUDFLARE_WORKERS_AI_TOKEN: "cloudflare-workers-ai-token-123456789012345",
    PLATFORM_INTERNAL_URL: "https://platform.example.com", AI_RELAY_CONTROL_TOKEN: "relay-control-token-1234567890123456789",
    AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890123" })!;
  const control = {
    check: vi.fn(async () => ({ identity: IDENTITY })),
    authorize: vi.fn(async (request: { requestId: string; modelId: string; maxCostMicrousd: number }) => ({
      identity: IDENTITY, reservation: { reservationId: "reservation_123", requestId: request.requestId,
        modelId: request.modelId, reservedMicrousd: 0, billingMode: "usage", billingPolicy: "postpaid",
        maxCostMicrousd: request.maxCostMicrousd, ...input.authorization } })),
    start: vi.fn(async (request: { executionId: string }) => ({ ...request, contractVersion: 1, status: "in_flight",
      startedAt: NOW.toISOString(), expiresAt: "2026-09-10T12:10:00.000Z", reservationId: "reservation_123",
      requestId: "request_123", tokenId: IDENTITY.tokenId })),
    release: vi.fn(async () => ({})), terminal: vi.fn(async () => ({})), finalize: vi.fn(async () => ({})),
  };
  const generation = vi.fn(async () => input.rejection
    ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "Limited" }, request_id: "req_123" }, { status: 429 })
    : input.unknown ? new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    : Response.json({ type: "message", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 2 } }));
  const fetchMock = vi.fn<typeof fetch>(async url => String(url).endsWith("/v1/messages/count_tokens")
    ? Response.json({ input_tokens: 10 }) : generation());
  const relay = createFundedRelay({ ...config, fetch: fetchMock, now: () => NOW,
    requestIdFactory: () => "request_123", platformClient: control as unknown as FundedPlatformClient });
  relays.push(relay);
  const app = new Hono(); relay.register(app);
  const send = () => app.request("/v1/messages", { method: "POST",
    headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hello" }], max_tokens: 256 }) });
  return { control, generation, send };
}

afterEach(async () => { await Promise.all(relays.splice(0).map(relay => relay.close())); });

describe("postpaid funded Relay requests", () => {
  it("negotiates zero customer hold despite legacy hold configuration and settles successful actual usage", async () => {
    const { control, send } = setup();
    const response = await send();
    expect(response.status).toBe(200); await response.text();
    expect(control.authorize).toHaveBeenCalledWith(expect.objectContaining({ billingMode: "usage", billingPolicy: "postpaid" }), expect.any(AbortSignal));
    await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith(expect.objectContaining({
      mode: "exact", actualCostMicrousd: expect.any(Number) }), expect.any(AbortSignal)));
    expect(control.finalize.mock.calls[0]?.[0]).not.toHaveProperty("customerCharge");
  });
  it("marks a known zero-cost Gateway rejection as a failed customer-charge disposition", async () => {
    const { control, send } = setup({ rejection: true });
    expect((await send()).status).toBe(429);
    await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith({ reservationId: "reservation_123",
      tokenId: IDENTITY.tokenId, mode: "exact", actualCostMicrousd: 0, customerCharge: "waived" }, expect.any(AbortSignal)));
  });
  it("reports missing usage as unknown rather than inventing a zero provider charge", async () => {
    const { control, send } = setup({ unknown: true });
    const response = await send(); expect(response.status).toBe(200); await response.text();
    await vi.waitFor(() => expect(control.terminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "usage_unknown" }), expect.any(AbortSignal)));
    expect(control.finalize).not.toHaveBeenCalled();
  });
  it.each([
    { billingPolicy: undefined }, { reservedMicrousd: 1 }, { billingMode: undefined }, { maxCostMicrousd: 1 },
  ])("does not dispatch against an unbound or contradictory no-hold authorization (%j)", async authorization => {
    const { control, generation, send } = setup({ authorization });
    expect((await send()).status).toBe(503);
    expect(generation).not.toHaveBeenCalled(); expect(control.start).not.toHaveBeenCalled();
    expect(control.release).toHaveBeenCalled();
  });
});
