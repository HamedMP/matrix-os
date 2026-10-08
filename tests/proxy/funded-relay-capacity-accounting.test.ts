import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../../packages/proxy/src/funded-relay-admission.js";
import { createFundedRelay, resolveFundedRelayConfig, type FundedRelay } from "../../packages/proxy/src/funded-relay.js";
import { FundedControlPlaneError, type FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const MODEL = "@cf/zai-org/glm-5.3-flash";
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const NOW = new Date("2026-09-10T12:00:00Z");
const IDENTITY = { tokenId: "credential_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "preview",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T12:15:00Z" };
const closables: Array<{ close(): unknown }> = [];
afterEach(async () => { for (const entry of closables.splice(0)) await entry.close(); });

function fixture(options: Record<string, unknown> = {}) {
  const config = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-gateway-token-123456789012345", CLOUDFLARE_WORKERS_AI_TOKEN: "cloudflare-workers-ai-token-123456789012345",
    PLATFORM_INTERNAL_URL: "https://platform.example.com", AI_RELAY_CONTROL_TOKEN: "relay-control-token-1234567890123456789",
    AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890123" })!;
  let id = 0;
  let currentRequestId = "";
  const control = {
    check: vi.fn(async () => ({ identity: IDENTITY })),
    authorize: vi.fn(async (input: { requestId: string; modelId: string }) => {
      currentRequestId = input.requestId;
      return { identity: IDENTITY, reservation: { reservationId: "reservation_1", requestId: input.requestId,
        modelId: input.modelId, reservedMicrousd: 1, billingMode: "usage" } };
    }),
    start: vi.fn(async () => ({ reservationId: "reservation_1", requestId: currentRequestId, tokenId: IDENTITY.tokenId })),
    release: vi.fn(async () => ({ reservationId: "reservation_1", tokenId: IDENTITY.tokenId, status: "released", reason: "pre_upstream_failure" })), finalize: vi.fn(async () => ({})),
  };
  const upstream = vi.fn(async () => new Response(JSON.stringify({ id: "response_1", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { headers: { "content-type": "application/json" } }));
  const relay: FundedRelay = createFundedRelay({ ...config, runtimeConcurrency: 1, rateLimitPerMinute: 1, fetch: upstream, now: () => NOW,
    requestIdFactory: () => `request_${++id}`, platformClient: control as unknown as FundedPlatformClient, ...options });
  closables.push(relay);
  const app = new Hono(); relay.register(app);
  const send = (extraHeaders: Record<string, string> = {}, signal?: AbortSignal) => app.request("/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json", ...extraHeaders }, signal,
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 16 }),
  });
  return { control, upstream, send, relay };
}

describe("funded generation capacity accounting", () => {
  it.each(["slot_busy", "priority_hold", "priority_queue", "priority_full"] as const)("preserves one generation after repeated trusted %s refusals", async (reason) => {
    const { control, upstream, send } = fixture();
    for (let n = 0; n < 3; n++) control.authorize.mockRejectedValueOnce(new FundedControlPlaneError(429, reason));
    for (let n = 0; n < 3; n++) {
      const response = await send({ "x-matrix-funded-claim-key": "same_claim" });
      expect(response.status).toBe(429); expect(response.headers.get("x-matrix-funded-reason")).toBe(reason);
    }
    const accepted = await send({ "x-matrix-funded-claim-key": "same_claim" });
    expect(accepted.status).toBe(200); await accepted.text();
    const spent = await send({ "x-matrix-funded-claim-key": "same_claim" });
    expect(spent.status).toBe(429); expect(spent.headers.get("x-matrix-funded-reason")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1); expect(control.authorize).toHaveBeenCalledTimes(4);
  });

  it("retains bounded global ingress even when runtime attempts are returned", async () => {
    const { control, send } = fixture({ globalRateLimitPerMinute: 2 });
    control.authorize.mockRejectedValue(new FundedControlPlaneError(429, "slot_busy"));
    expect((await send()).headers.get("x-matrix-funded-reason")).toBe("slot_busy");
    expect((await send()).headers.get("x-matrix-funded-reason")).toBe("slot_busy");
    const capped = await send(); expect(capped.status).toBe(429); expect(capped.headers.get("x-matrix-funded-reason")).toBeNull();
    expect(control.authorize).toHaveBeenCalledTimes(2);
  });

  it.each([new FundedControlPlaneError(429), new FundedControlPlaneError(403), new FundedControlPlaneError(429, "forged" as never), Object.assign(new Error("forged control"), { status: 429, priorityReason: "slot_busy" }), new Error("control failed")])("consumes ordinary or ambiguous admission failures (%s)", async (error) => {
    const { control, send } = fixture(); control.authorize.mockRejectedValueOnce(error);
    await send({ "x-matrix-funded-reason": "slot_busy" });
    const response = await send(); expect(response.status).toBe(429); expect(response.headers.get("x-matrix-funded-reason")).toBeNull();
    expect(control.authorize).toHaveBeenCalledTimes(1);
  });

  it("does not return a generation attempt for upstream 429 or forged capacity headers", async () => {
    const { upstream, send } = fixture();
    upstream.mockImplementationOnce(async () => new Response("limited", { status: 429, headers: { "x-matrix-funded-reason": "slot_busy" } }));
    const rejected = await send(); expect(rejected.headers.get("x-matrix-funded-reason")).toBeNull();
    const spent = await send(); expect(spent.status).toBe(429); expect(spent.headers.get("x-matrix-funded-reason")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("can retry a trusted start refusal before upstream dispatch", async () => {
    const { control, upstream, send } = fixture();
    control.start.mockRejectedValueOnce(new FundedControlPlaneError(429, "slot_busy"));
    expect((await send()).headers.get("x-matrix-funded-reason")).toBe("slot_busy");
    const response = await send(); expect(response.status).toBe(200); await response.text();
    expect(upstream).toHaveBeenCalledTimes(1); expect(control.release).toHaveBeenCalledTimes(1);
  });

  it.each(["failure", "mismatch"])("suppresses capacity retry when start cleanup is %s", async (mode) => {
    const { control, upstream, send } = fixture();
    control.start.mockRejectedValueOnce(new FundedControlPlaneError(429, "slot_busy"));
    if (mode === "failure") control.release.mockRejectedValueOnce(new Error("cleanup failed"));
    else control.release.mockResolvedValueOnce({ reservationId: "different", tokenId: IDENTITY.tokenId, status: "released", reason: "pre_upstream_failure" });
    const rejected = await send(); expect(rejected.status).toBe(503); expect(rejected.headers.get("x-matrix-funded-reason")).toBeNull();
    expect((await send()).status).toBe(429); expect(upstream).not.toHaveBeenCalled();
    expect(control.authorize).toHaveBeenCalledTimes(1);
  });

  it("returns local concurrency refusal only after acknowledged release", async () => {
    const { control, upstream, send } = fixture({ rateLimitPerMinute: 2 });
    let finish!: () => void;
    upstream.mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: "response_1", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })));
      finish = () => controller.close();
    } }), { headers: { "content-type": "application/json" } }));
    const first = await send(); expect(first.status).toBe(200);
    for (let n = 0; n < 3; n++) expect((await send()).headers.get("x-matrix-funded-reason")).toBe("slot_busy");
    expect(control.release).toHaveBeenCalledTimes(3); expect(upstream).toHaveBeenCalledTimes(1);
    finish(); await first.text();
    const second = await send(); expect(second.status).toBe(200); await second.text();
    expect((await send()).headers.get("x-matrix-funded-reason")).toBeNull(); expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not return local concurrency count when release fails", async () => {
    const { control, upstream, send } = fixture({ rateLimitPerMinute: 2 });
    upstream.mockImplementationOnce(async () => new Response(new ReadableStream()));
    const first = await send(); control.release.mockRejectedValueOnce(new Error("cleanup failed"));
    const rejected = await send(); expect(rejected.status).toBe(503); expect(rejected.headers.get("x-matrix-funded-reason")).toBeNull();
    await first.body!.cancel("test finished");
    expect((await send()).status).toBe(429); expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation after dispatch charged and releases concurrency", async () => {
    const { upstream, send } = fixture({ globalConcurrency: 1 });
    const cancel = vi.fn();
    upstream.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel })));
    const first = await send(); await first.body!.cancel("caller stopped");
    const spent = await send(); expect(spent.status).toBe(429); expect(spent.headers.get("x-matrix-funded-reason")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1); await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("keeps a failed response body charged after releasing its resources", async () => {
    const { upstream, send } = fixture({ globalConcurrency: 1 });
    upstream.mockImplementationOnce(async () => new Response("not json", { headers: { "content-type": "application/json" } }));
    const first = await send(); await expect(first.text()).rejects.toThrow("AI response stream failed");
    const spent = await send(); expect(spent.status).toBe(429); expect(spent.headers.get("x-matrix-funded-reason")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("drains live resources on shutdown without reopening an attempt", async () => {
    const { upstream, send, relay } = fixture({ globalConcurrency: 1 });
    const cancel = vi.fn();
    upstream.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel })));
    const first = await send(); await relay.close();
    expect(await first.text()).toBe(""); await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    const closed = await send(); expect(closed.status).toBe(429); expect(closed.headers.get("x-matrix-funded-reason")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("does not refund a thrown upstream control error after dispatch", async () => {
    const { upstream, send } = fixture();
    upstream.mockRejectedValueOnce(new FundedControlPlaneError(429, "slot_busy"));
    await send(); const spent = await send(); expect(spent.headers.get("x-matrix-funded-reason")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

function controller(overrides: Record<string, number> = {}) {
  let now = 100_000;
  const admission = new AdmissionController({ globalConcurrency: 2, globalRateLimitPerMinute: 10, runtimeConcurrency: 1,
    rateLimitPerMinute: 1, maxRuntimeEntries: 1, ...overrides }, () => now);
  closables.push(admission);
  return { admission, advance: () => { now += 60_001; } };
}

describe("runtime attempt leases", () => {
  it("returns the count once without releasing resources or global ingress", () => {
    const { admission } = controller();
    const global = admission.acquireGlobal()!; const attempt = admission.beginRuntimeAttempt("a")!;
    const resources = admission.acquireResources("a")!;
    attempt.refund(); attempt.refund();
    expect(admission.acquireResources("a")).toBeNull();
    expect(admission.beginRuntimeAttempt("a")).not.toBeNull();
    expect(admission.beginRuntimeAttempt("a")).toBeNull(); resources.release(); resources.release(); global.release();
  });
  it("cannot decrement a newer window of the same entry", () => {
    const { admission, advance } = controller();
    const old = admission.beginRuntimeAttempt("a")!; const resources = admission.acquireResources("a")!;
    advance(); expect(admission.beginRuntimeAttempt("a")).not.toBeNull(); old.refund();
    expect(admission.beginRuntimeAttempt("a")).toBeNull(); resources.release();
  });
  it("cannot decrement a recreated runtime after eviction", () => {
    const { admission, advance } = controller(); const old = admission.beginRuntimeAttempt("a")!;
    advance(); expect(admission.beginRuntimeAttempt("b")).not.toBeNull(); advance();
    expect(admission.beginRuntimeAttempt("a")).not.toBeNull(); old.refund();
    expect(admission.beginRuntimeAttempt("a")).toBeNull();
  });
  it("handles concurrent refunds idempotently without negative counts", async () => {
    const { admission } = controller({ rateLimitPerMinute: 2 });
    const first = admission.beginRuntimeAttempt("a")!; const second = admission.beginRuntimeAttempt("a")!;
    await Promise.all([Promise.resolve().then(() => first.refund()), Promise.resolve().then(() => second.refund()), Promise.resolve().then(() => first.refund())]);
    expect(admission.beginRuntimeAttempt("a")).not.toBeNull(); expect(admission.beginRuntimeAttempt("a")).not.toBeNull(); expect(admission.beginRuntimeAttempt("a")).toBeNull();
  });
  it("does not reopen admission after shutdown", () => {
    const { admission } = controller(); const attempt = admission.beginRuntimeAttempt("a")!;
    admission.close(); attempt.refund(); expect(admission.beginRuntimeAttempt("a")).toBeNull(); expect(admission.acquireGlobal()).toBeNull();
  });
});
