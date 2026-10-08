import { FUNDED_AI_READINESS_TIMEOUTS } from "@matrix-os/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const MODEL = "@cf/zai-org/glm-5.3-flash";
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const NOW = new Date("2026-09-10T12:00:00Z");
const IDENTITY = {
  tokenId: "credential_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "preview",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T12:15:00Z",
};

function config(overrides: NodeJS.ProcessEnv = {}) {
  return resolveFundedRelayConfig({
    MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
    PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: "c".repeat(32),
    AI_RELAY_METADATA_SECRET: "m".repeat(32), ...overrides,
  })!;
}

function reply() {
  return Response.json({ success: true, result: {
    id: "response_1", object: "chat.completion", model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "The tool result is ready." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 10 } },
  } });
}

const relays: ReturnType<typeof createFundedRelay>[] = [];
function fixture(delayMs: number | null, overrides: NodeJS.ProcessEnv = {}) {
  const control = {
    check: vi.fn(async () => ({ identity: IDENTITY })),
    authorize: vi.fn(async (input: { requestId: string; modelId: string }) => ({
      identity: IDENTITY, reservation: { reservationId: "reservation_1", requestId: input.requestId,
        modelId: input.modelId, reservedMicrousd: 1, billingMode: "usage" },
    })),
    start: vi.fn(async () => ({ reservationId: "reservation_1", requestId: "request_1", tokenId: IDENTITY.tokenId })),
    release: vi.fn(), finalize: vi.fn(async () => ({})),
  };
  let signal!: AbortSignal;
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    signal = init!.signal!;
    signal.throwIfAborted();
    return await new Promise<Response>((resolve, reject) => {
      const abort = () => { if (timer !== undefined) clearTimeout(timer); reject(signal.reason); };
      const timer = delayMs === null ? undefined : setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve(reply());
      }, delayMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  });
  const relay = createFundedRelay({ ...config(overrides), fetch: fetchFn, now: () => NOW,
    requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient });
  relays.push(relay);
  const app = new Hono(); relay.register(app);
  function request(callerSignal?: AbortSignal) {
    return app.request("/v1/chat/completions", {
      method: "POST", signal: callerSignal,
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 256, messages: [
        { role: "user", content: "Use the connected tool to retrieve the profile." },
        { role: "assistant", content: null, tool_calls: [{ id: "tool_1", type: "function",
          function: { name: "get_profile", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "tool_1", content: "Synthetic profile result" },
      ] }),
    });
  }
  function expectSingleDispatch() {
    expect(control.check).toHaveBeenCalledTimes(1);
    expect(control.authorize).toHaveBeenCalledTimes(1);
    expect(control.start).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(control.release).not.toHaveBeenCalled();
  }
  async function expectUnresolvedSettlement() {
    await relay.close();
    expectSingleDispatch();
    expect(control.finalize).toHaveBeenCalledTimes(1);
    expect(control.finalize).toHaveBeenCalledWith({ reservationId: "reservation_1", tokenId: IDENTITY.tokenId,
      mode: "conservative" }, expect.any(AbortSignal));
  }
  return { request, relay, control, fetchFn, signal: () => signal, expectSingleDispatch, expectUnresolvedSettlement };
}

describe("funded generation first-response budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Adapt Node's native timeout clock, preserving the actual composed abort signals.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), delay);
      return controller.signal;
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    for (const relay of relays.splice(0)) await relay.close();
    vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
  });

  it("defaults generation to thirty seconds while preserving the total and readiness budgets", () => {
    expect(config().firstResponseTimeoutMs).toBe(30_000);
    expect(config().timeoutMs).toBe(600_000);
    expect(config().countTokensTimeoutMs).toBe(10_000);
    expect(FUNDED_AI_READINESS_TIMEOUTS.relayUpstreamProbeMs).toBe(8_000);
    expect(FUNDED_AI_READINESS_TIMEOUTS.relayProbeMs).toBe(10_000);
  });

  it.each(["1000", "5000", "60000"])("retains the explicit first-response override %s", (value) => {
    expect(config({ MATRIX_FUNDED_AI_FIRST_RESPONSE_TIMEOUT_MS: value }).firstResponseTimeoutMs).toBe(Number(value));
  });
  it.each(["999", "60001", "1.5", "invalid"])("rejects invalid first-response override %s", (value) => {
    expect(() => config({ MATRIX_FUNDED_AI_FIRST_RESPONSE_TIMEOUT_MS: value })).toThrow(
      "MATRIX_FUNDED_AI_FIRST_RESPONSE_TIMEOUT_MS must be an integer between 1000 and 60000");
  });

  it("permits a fifteen-second GLM tool continuation and settles it exactly once", async () => {
    const f = fixture(15_000);
    let response: Response | undefined;
    const pending = f.request().then((value) => { response = value; return value; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(response).toBeUndefined();
    expect(f.signal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    const result = await pending;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ choices: [{ message: { content: "The tool result is ready." } }] });
    await f.relay.close();
    f.expectSingleDispatch();
    expect(JSON.parse(String(f.fetchFn.mock.calls[0]![1]!.body))).toMatchObject({ messages: [
      { role: "user" },
      { role: "assistant", tool_calls: [{ id: "tool_1", function: { name: "get_profile", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tool_1", content: "Synthetic profile result" },
    ] });
    expect(f.control.finalize).toHaveBeenCalledTimes(1);
    expect(f.control.finalize).toHaveBeenCalledWith({ reservationId: "reservation_1", tokenId: IDENTITY.tokenId,
      mode: "exact", actualCostMicrousd: 24 }, expect.any(AbortSignal));
  });

  it("aborts a stalled generation at exactly thirty seconds without redispatch or releasing unknown usage", async () => {
    const f = fixture(null);
    let response: Response | undefined;
    const pending = f.request().then((value) => { response = value; return value; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(response).toBeUndefined();
    expect(f.signal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
    expect(f.signal().reason).toMatchObject({ name: "TimeoutError" });
    await f.expectUnresolvedSettlement();
  });

  it("honors an explicit shorter first-response budget", async () => {
    const f = fixture(15_000, { MATRIX_FUNDED_AI_FIRST_RESPONSE_TIMEOUT_MS: "5000" });
    let response: Response | undefined;
    const pending = f.request().then((value) => { response = value; return value; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(response).toBeUndefined(); expect(f.signal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
    expect(f.signal().aborted).toBe(true);
    await f.expectUnresolvedSettlement();
  });

  it("honors caller cancellation before the first-response deadline", async () => {
    const f = fixture(null);
    const caller = new AbortController();
    const pending = f.request(caller.signal);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.signal().aborted).toBe(false);
    const reason = new DOMException("Caller canceled", "AbortError");
    caller.abort(reason);
    expect((await pending).status).toBe(504);
    expect(f.signal().reason).toBe(reason);
    await f.expectUnresolvedSettlement();
  });

  it("lets a shorter total lifetime cancel generation before the first-response deadline", async () => {
    const f = fixture(null, { MATRIX_FUNDED_AI_TIMEOUT_MS: "10000" });
    let response: Response | undefined;
    const pending = f.request().then((value) => { response = value; return value; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(response).toBeUndefined(); expect(f.signal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
    expect(f.signal().aborted).toBe(true);
    await f.expectUnresolvedSettlement();
  });
});
