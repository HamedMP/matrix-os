import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { FundedControlPlaneError, type FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const CREDENTIAL = `sk-matrix-funded-token_123.${"s".repeat(43)}`;
const IDENTITY = { tokenId: "token_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "primary",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T13:00:00.000Z" };
const relays: ReturnType<typeof createFundedRelay>[] = [];

function setup(input: { rejection?: boolean; unknown?: boolean; authorization?: object;
  reservationMode?: "usage" | "cloudflare-count"; now?: () => Date; runtimeRateLimit?: number } = {}) {
  const config = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true",
    // A legacy deployment setting cannot opt customers back into monetary holds.
    MATRIX_FUNDED_AI_RESERVATION_MODE: input.reservationMode ?? "cloudflare-count",
    MATRIX_FUNDED_AI_RATE_LIMIT: input.runtimeRateLimit?.toString(),
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
  const relay = createFundedRelay({ ...config, fetch: fetchMock, now: input.now ?? (() => NOW),
    requestIdFactory: () => "request_123", platformClient: control as unknown as FundedPlatformClient });
  relays.push(relay);
  const app = new Hono(); relay.register(app);
  const send = (options: { path?: string; credential?: string } = {}) => app.request(options.path ?? "/v1/messages", { method: "POST",
    headers: { authorization: `Bearer ${options.credential ?? CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hello" }],
      ...(options.path === "/v1/messages/count_tokens" ? {} : { max_tokens: 256 }) }) });
  return { control, generation, send, fetchMock };
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
  it.each([401, 403])("still checks authoritative admission on a warm identity and returns %s without upstream dispatch", async status => {
    const { control, generation, send } = setup({ reservationMode: "usage" });
    const first = await send();
    expect(first.status).toBe(200);
    await first.text();
    control.authorize.mockRejectedValueOnce(new FundedControlPlaneError(status));

    expect((await send()).status).toBe(status);
    expect(control.check).toHaveBeenCalledTimes(1);
    expect(control.authorize).toHaveBeenCalledTimes(2);
    expect(control.start).toHaveBeenCalledTimes(1);
    expect(generation).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("evicts a warm identity denied with %s and preserves the runtime quota", async status => {
    const { control, generation, send } = setup({ reservationMode: "usage", runtimeRateLimit: 2 });
    const admitted = await send();
    expect(admitted.status).toBe(200);
    await admitted.text();

    control.authorize.mockRejectedValueOnce(new FundedControlPlaneError(status, undefined, undefined, true));
    expect((await send()).status).toBe(status);

    const refreshed = await send({ credential: CREDENTIAL.replace(/s$/, "x") });
    expect(refreshed.status).toBe(200);
    await refreshed.text();

    control.check.mockRejectedValueOnce(new FundedControlPlaneError(status));
    expect((await send()).status).toBe(status);
    expect(control.check).toHaveBeenCalledTimes(3);
    expect(control.authorize).toHaveBeenCalledTimes(3);
    expect(generation).toHaveBeenCalledTimes(2);
  });

  it.each([
    new FundedControlPlaneError(402, undefined, "insufficient_credit"),
    new FundedControlPlaneError(403, undefined, "budget_exceeded"),
    new FundedControlPlaneError(403),
  ])("keeps funding and ambiguous denials within the runtime quota on a cache hit (%s)", async denial => {
    const { control, generation, send } = setup({ reservationMode: "usage", runtimeRateLimit: 2 });
    const admitted = await send();
    expect(admitted.status).toBe(200);
    await admitted.text();

    control.authorize.mockRejectedValueOnce(denial);
    expect((await send()).status).toBe(403);
    expect((await send()).status).toBe(429);
    expect(control.check).toHaveBeenCalledTimes(1);
    expect(control.authorize).toHaveBeenCalledTimes(2);
    expect(generation).toHaveBeenCalledTimes(1);
  });

  it("performs fresh checks for a different bearer, expired identity and upstream token counting", async () => {
    let at = NOW;
    const { control, fetchMock, send } = setup({ reservationMode: "usage", now: () => at });
    const first = await send();
    expect(first.status).toBe(200);
    await first.text();

    control.check.mockRejectedValueOnce(new FundedControlPlaneError(401));
    const different = await send({ credential: CREDENTIAL.replace(/s$/, "x") });
    expect(different.status).toBe(401);
    control.check.mockRejectedValueOnce(new FundedControlPlaneError(403));
    const count = await send({ path: "/v1/messages/count_tokens" });
    expect(count.status).toBe(403);
    at = new Date(NOW.getTime() + 30_000);
    control.check.mockRejectedValueOnce(new FundedControlPlaneError(401));
    expect((await send()).status).toBe(401);
    expect(control.check).toHaveBeenCalledTimes(4);
    expect(control.authorize).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
