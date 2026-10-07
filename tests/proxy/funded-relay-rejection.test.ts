import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { classifyFundedUpstreamRejection } from "../../packages/proxy/src/funded-relay-rejection.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const NOW = new Date("2026-09-10T12:00:00Z");
const SONNET = "anthropic/claude-sonnet-5";
const GLM = "@cf/zai-org/glm-5.3-flash";
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const IDENTITY = {
  tokenId: "credential_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "preview",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T12:15:00Z",
};
const rejection = { type: "error", error: { type: "rate_limit_error", message: "Rate limited" }, request_id: "req_test" };

function json(value: unknown, status = 429): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function setup(upstream: () => Response | Promise<Response>, model = SONNET) {
  const control = {
    check: vi.fn(async () => ({ identity: IDENTITY })),
    authorize: vi.fn(async (input: { requestId: string; modelId: string }) => ({
      identity: IDENTITY, reservation: { reservationId: "reservation_1", requestId: input.requestId,
        modelId: input.modelId, reservedMicrousd: 100_000, billingMode: "usage" },
    })),
    start: vi.fn(async () => ({ reservationId: "reservation_1", requestId: "request_1", tokenId: IDENTITY.tokenId })),
    release: vi.fn(), finalize: vi.fn(async (task: unknown, signal: AbortSignal) => { void task; void signal; return {}; }),
  };
  const config = resolveFundedRelayConfig({
    MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-gateway-token-123456789012345",
    CLOUDFLARE_WORKERS_AI_TOKEN: "cloudflare-workers-ai-token-123456789012345",
    PLATFORM_INTERNAL_URL: "https://platform.example.com", AI_RELAY_CONTROL_TOKEN: "relay-control-token-1234567890123456789",
    AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890123",
  })!;
  const fetchMock = vi.fn(async () => upstream());
  const relay = createFundedRelay({ ...config, fetch: fetchMock, now: () => NOW,
    requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient });
  const app = new Hono(); relay.register(app);
  const send = () => app.request(model === SONNET ? "/v1/messages" : "/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({ model: model === SONNET ? "claude-sonnet-5" : model,
      messages: [{ role: "user", content: "hello" }], max_tokens: 256, stream: true }),
  });
  return { control, relay, fetchMock, send };
}

afterEach(() => vi.restoreAllMocks());

describe("funded generation rejection settlement", () => {
  it("settles a complete Anthropic pre-stream rate-limit rejection at exact zero without generation retry", async () => {
    const { control, relay, fetchMock, send } = setup(() => json(rejection));
    try {
      const response = await send();
      expect(response.status).toBe(429);
      expect(response.headers.get("x-matrix-funded-reason")).toBeNull();
      await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith({
        reservationId: "reservation_1", tokenId: IDENTITY.tokenId, mode: "exact", actualCostMicrousd: 0,
      }, expect.any(AbortSignal)));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(control.release).not.toHaveBeenCalled();
    } finally { await relay.close(); }
  });

  it("retains the same exact-zero settlement through a control-plane outage and shutdown drain", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { control, relay, fetchMock, send } = setup(() => json(rejection));
    control.finalize.mockRejectedValueOnce(new Error("temporary control failure"));
    await send();
    await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await relay.close();
    expect(control.finalize).toHaveBeenCalledTimes(2);
    for (const [task] of control.finalize.mock.calls) expect(task).toMatchObject({ mode: "exact", actualCostMicrousd: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(control.release).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", () => new Response("{", { status: 429, headers: { "content-type": "application/json" } })],
    ["bare text", () => new Response("Rate limited", { status: 429 })],
    ["missing body", () => new Response(null, { status: 429 })],
    ["wrong error type", () => json({ ...rejection, error: { type: "api_error", message: "Unknown" } })],
    ["missing error message", () => json({ type: "error", error: { type: "rate_limit_error" } })],
    ["success-shaped body", () => json({ type: "message", error: rejection.error })],
    ["contradictory usage", () => json({ ...rejection, usage: { input_tokens: 12, output_tokens: 1 } })],
    ["contradictory generated content", () => json({ ...rejection, content: [{ type: "text", text: "partial reply" }] })],
    ["unexpected nested error evidence", () => json({ ...rejection, error: { ...rejection.error, usage: { output_tokens: 1 } } })],
    ["server failure", () => json(rejection, 500)],
    ["SSE media type", () => new Response(JSON.stringify(rejection), { status: 429, headers: { "content-type": "text/event-stream" } })],
    ["oversized rejection", () => json({ ...rejection, padding: "x".repeat(20_000) })],
  ] as const)("keeps %s conservative", async (_label, upstream) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { control, relay, send } = setup(upstream);
    try {
      await send();
      await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith({
        reservationId: "reservation_1", tokenId: IDENTITY.tokenId, mode: "conservative",
      }, expect.any(AbortSignal)));
      expect(control.release).not.toHaveBeenCalled();
    } finally { await relay.close(); }
  });

  it("does not apply the Anthropic rejection rule to Workers AI", async () => {
    const { control, relay, send } = setup(() => json(rejection), GLM);
    try {
      await send();
      await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith(expect.objectContaining({ mode: "conservative" }), expect.any(AbortSignal)));
    } finally { await relay.close(); }
  });

  it("does not treat a rate-limit error within an accepted SSE response as zero usage", async () => {
    const { control, relay, send } = setup(() => new Response(`data: ${JSON.stringify(rejection)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }));
    try {
      const response = await send();
      expect(response.status).toBe(200);
      await response.text();
      await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith(expect.objectContaining({ mode: "conservative" }), expect.any(AbortSignal)));
    } finally { await relay.close(); }
  });
});


describe("bounded rejection evidence", () => {
  it("times out a stalled body even if upstream cancellation never resolves", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const upstream = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 429, headers: { "content-type": "application/json" },
    });
    try {
      const result = classifyFundedUpstreamRejection({ upstream, canonicalModelId: SONNET,
        requestPath: "/v1/messages", signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await result).toEqual({ mode: "conservative" });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(upstream.body?.locked).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("keeps caller-aborted rejection reads conservative", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = new AbortController();
    const cancel = vi.fn();
    const result = classifyFundedUpstreamRejection({ upstream: new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 429, headers: { "content-type": "application/json" },
    }), canonicalModelId: SONNET, requestPath: "/v1/messages", signal: controller.signal });
    controller.abort(new DOMException("Cancelled", "AbortError"));
    expect(await result).toEqual({ mode: "conservative" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["/v1/chat/completions", "/v1/messages/count_tokens"])("does not infer zero usage for %s", async (requestPath) => {
    expect(await classifyFundedUpstreamRejection({ upstream: json(rejection), canonicalModelId: SONNET,
      requestPath, signal: new AbortController().signal })).toEqual({ mode: "conservative" });
  });

  it("rejects invalid UTF-8 instead of repairing the evidence", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bytes = new TextEncoder().encode(JSON.stringify(rejection));
    bytes[bytes.indexOf(82)] = 255;
    expect(await classifyFundedUpstreamRejection({ upstream: new Response(bytes, {
      status: 429, headers: { "content-type": "application/json" },
    }), canonicalModelId: SONNET, requestPath: "/v1/messages",
    signal: new AbortController().signal })).toEqual({ mode: "conservative" });
  });

  it("rejects an oversized declared body before reading it", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const upstream = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), {
      status: 429, headers: { "content-type": "application/json", "content-length": "20000" },
    });
    expect(await classifyFundedUpstreamRejection({ upstream, canonicalModelId: SONNET,
      requestPath: "/v1/messages", signal: new AbortController().signal })).toEqual({ mode: "conservative" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
