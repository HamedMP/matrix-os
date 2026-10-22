import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../../packages/proxy/src/funded-relay-admission.js";
import { boundedBody } from "../../packages/proxy/src/funded-relay-stream.js";
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
    start: vi.fn(async (input: { executionId?: string }) => ({ executionId: input.executionId, contractVersion: 1, status: "in_flight", startedAt: NOW.toISOString(), expiresAt: "2026-09-10T12:10:00.000Z", reservationId: "reservation_1", requestId: currentRequestId, tokenId: IDENTITY.tokenId })),
    release: vi.fn(async () => ({ reservationId: "reservation_1", tokenId: IDENTITY.tokenId, status: "released", reason: "pre_upstream_failure" })), terminal: vi.fn(async () => ({})), finalize: vi.fn(async () => ({})),
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
  return { control, upstream, send, relay, app };
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
  it("waits for original Workers body cancellation after normalization failure before attesting terminal", async () => {
    const { upstream, control, send } = fixture(); const cancellation = Promise.withResolvers<void>();
    upstream.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: {invalid-json}\n\n")); }, cancel: () => cancellation.promise,
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await send(); await expect(response.text()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0)); expect(control.terminal).not.toHaveBeenCalled();
    cancellation.resolve(); await vi.waitFor(() => expect(control.terminal).toHaveBeenCalledTimes(1));
  });

});

describe("stalled stream cancellation cleanup", () => {
  it("frees Relay capacity at the existing cancellation deadline without releasing unknown funding", async () => {
    vi.useFakeTimers();
    const cancellation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const caller = new AbortController();
    const { control, upstream, send, app } = fixture({ globalConcurrency: 1, rateLimitPerMinute: 5,
      platformTimeoutMs: 750, timeoutMs: 60_000 });
    upstream.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      cancel: () => { entered.resolve(); return cancellation.promise; },
    }), { headers: { "content-type": "text/event-stream" } }));
    try {
      const first = await app.request("/v1/messages", { method: "POST", signal: caller.signal,
        headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, stream: true,
          messages: [{ role: "user", content: "hi" }] }) });
      expect(first.status).toBe(200);
      caller.abort("caller stopped");
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_499);
      expect((await send()).status).toBe(429);
      expect(control.authorize).toHaveBeenCalledTimes(1);
      expect(control.terminal).not.toHaveBeenCalled();
      expect(control.finalize).not.toHaveBeenCalled();
      expect(control.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      const otherIdentity = { ...IDENTITY, ownerId: "owner_other", tokenId: "credential_other", machineId: "machine_other" };
      let otherRequest = "";
      control.check.mockResolvedValueOnce({ identity: otherIdentity });
      control.authorize.mockImplementationOnce(async (input) => {
        otherRequest = input.requestId;
        return { identity: otherIdentity, reservation: { reservationId: "reservation_other", requestId: input.requestId,
          modelId: input.modelId, reservedMicrousd: 1, billingMode: "usage" } };
      });
      control.start.mockImplementationOnce(async (input) => ({ executionId: input.executionId, contractVersion: 1,
        status: "in_flight", startedAt: NOW.toISOString(), expiresAt: "2026-09-10T12:10:00.000Z",
        reservationId: "reservation_other", requestId: otherRequest, tokenId: otherIdentity.tokenId }));
      const accepted = await send({ authorization: `Bearer sk-matrix-funded-credential_other.${"s".repeat(43)}` });
      expect(accepted.status).toBe(200);
      await accepted.text();
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(control.finalize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reservationId: "reservation_other" }), expect.any(AbortSignal));
      expect(control.terminal).not.toHaveBeenCalled();
      expect(control.release).not.toHaveBeenCalled();
    } finally {
      cancellation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("keeps late cancellation proof separate from a newer local lease", async () => {
    vi.useFakeTimers();
    const cancellation = Promise.withResolvers<void>();
    const { admission } = controller({ globalConcurrency: 1, rateLimitPerMinute: 2 });
    const global = admission.acquireGlobal()!;
    admission.beginRuntimeAttempt("owner");
    const resources = admission.acquireResources("owner")!;
    const release = vi.fn(() => { resources.release(); global.release(); });
    const ambiguous = vi.fn();
    const complete = vi.fn();
    const body = boundedBody(new ReadableStream<Uint8Array>({ cancel: () => cancellation.promise }), 100,
      { release }, () => undefined, new AbortController().signal,
      { push: () => undefined, complete, ambiguous }, 100);
    const pending = body.cancel("caller stopped");
    try {
      await vi.advanceTimersByTimeAsync(99);
      expect(admission.acquireGlobal()).toBeNull();
      expect(admission.acquireResources("owner")).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(release).toHaveBeenCalledTimes(1);
      await pending;
      expect(ambiguous).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      const nextGlobal = admission.acquireGlobal();
      const nextResources = admission.acquireResources("owner");
      expect(nextGlobal).not.toBeNull();
      expect(nextResources).not.toBeNull();
      cancellation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(ambiguous).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(admission.acquireGlobal()).toBeNull();
      expect(admission.acquireResources("owner")).toBeNull();
      nextResources?.release();
      nextGlobal?.release();
    } finally {
      cancellation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("preserves the durable terminal barrier after cancellation acknowledges within budget", async () => {
    vi.useFakeTimers();
    const cancellation = Promise.withResolvers<void>();
    const publication = Promise.withResolvers<void>();
    const release = vi.fn();
    const ambiguous = vi.fn(() => publication.promise);
    const complete = vi.fn();
    const body = boundedBody(new ReadableStream<Uint8Array>({ cancel: () => cancellation.promise }), 100,
      { release }, () => undefined, new AbortController().signal,
      { push: () => undefined, complete, ambiguous }, 100);
    let completed = false;
    const pending = body.cancel("caller stopped").then(() => { completed = true; });
    try {
      await vi.advanceTimersByTimeAsync(50);
      cancellation.resolve();
      await vi.advanceTimersByTimeAsync(150);
      expect(ambiguous).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(completed).toBe(false);
      publication.resolve();
      await pending;
      expect(release).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cancellation.resolve();
      publication.resolve();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("keeps pending-pull cancellation leased until its acknowledgement and terminal barrier", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reading = Promise.withResolvers<void>();
    const cancellation = Promise.withResolvers<void>();
    const publication = Promise.withResolvers<void>();
    const release = vi.fn();
    const ambiguous = vi.fn(() => publication.promise);
    const complete = vi.fn();
    const body = boundedBody(new ReadableStream<Uint8Array>({
      pull: () => { reading.resolve(); }, cancel: () => cancellation.promise,
    }, { highWaterMark: 0 }), 100, { release }, () => undefined, new AbortController().signal,
    { push: () => undefined, complete, ambiguous }, 100);
    const reader = body.getReader();
    const firstRead = reader.read();
    await reading.promise;
    const pending = reader.cancel("caller stopped");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(release).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(ambiguous).not.toHaveBeenCalled();
      cancellation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(ambiguous).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      publication.resolve();
      await pending;
      expect(await firstRead).toEqual({ done: true, value: undefined });
      expect(release).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cancellation.resolve();
      publication.resolve();
      await vi.advanceTimersByTimeAsync(0);
      reader.releaseLock();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
