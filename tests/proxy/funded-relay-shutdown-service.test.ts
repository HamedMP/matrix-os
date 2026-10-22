import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FundedAiTerminalOutcomeRequest } from "@matrix-os/contracts";
import { createFundedRelayService } from "../../packages/proxy/src/funded-main-app.js";
import { resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const tracker = vi.hoisted(() => ({ shutdown: vi.fn<() => Promise<void>>() }));
vi.mock("@matrix-os/observability", () => ({ installPostHogHonoErrorTracking: () => tracker }));
beforeEach(() => {
  vi.useFakeTimers(); tracker.shutdown.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
const MODEL = "@cf/zai-org/glm-5.3-flash";
const NOW = new Date("2026-09-10T12:00:00.000Z");
const IDENTITY = { tokenId: "credential_123", ownerId: "owner", machineId: "machine", runtimeSlot: "primary",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T12:15:00.000Z" };
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
function deadline(ms = 9000) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("Shutdown deadline", "TimeoutError")), ms);
  return controller.signal;
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
function fixture(cancel: () => void | Promise<void> = () => undefined, model = MODEL) {
  let requestId = "";
  let reservationId = "";
  let reservation = 0;
  const control = {
    check: vi.fn(async () => ({ identity: IDENTITY })),
    authorize: vi.fn(async (input: { requestId: string; modelId: string }) => {
      requestId = input.requestId;
      reservationId = `reservation_${++reservation}`;
      return { identity: IDENTITY, reservation: { reservationId, requestId, modelId: input.modelId, reservedMicrousd: 1, billingMode: "usage" } };
    }),
    start: vi.fn(async (input: { executionId?: string }) => ({ executionId: input.executionId, contractVersion: 1, status: "in_flight",
      startedAt: NOW.toISOString(), expiresAt: "2026-09-10T12:10:00.000Z", reservationId, requestId, tokenId: IDENTITY.tokenId })),
    terminal: vi.fn(async (_task: FundedAiTerminalOutcomeRequest, _signal: AbortSignal) => ({})),
    finalize: vi.fn(async () => ({})), release: vi.fn(async () => ({})),
  };
  const upstream = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-type": "application/json" } }));
  const config = { ...resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/offline/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
    PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: "c".repeat(32), AI_RELAY_METADATA_SECRET: "m".repeat(32) })!,
    fetch: upstream, platformClient: control as unknown as FundedPlatformClient, now: () => NOW };
  const service = createFundedRelayService(config);
  const send = () => service.app.request(model === MODEL ? "/v1/chat/completions" : "/v1/messages", { method: "POST", headers: {
    authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Synthetic lifecycle fixture" }], max_tokens: 16 }) });
  return { service, control, upstream, send };
}

describe("funded service shared shutdown outcome", () => {
  it("keeps the original receipt retry alive for a five-plus-two-second recovery", async () => {
    const f = fixture(); const receipts: FundedAiTerminalOutcomeRequest[] = [];
    f.control.terminal.mockImplementation(async (task, signal) => {
      receipts.push(task);
      if (receipts.length === 1) { await delay(5000, signal); throw new DOMException("Platform timeout", "TimeoutError"); }
      await delay(2000, signal); return {};
    });
    expect((await f.send()).status).toBe(200);
    const closing = f.service.close(deadline());
    await vi.advanceTimersByTimeAsync(7000);
    expect(await closing).toBe(true);
    expect(receipts).toHaveLength(2); expect(receipts[1]).toEqual(receipts[0]);
    expect(f.upstream).toHaveBeenCalledTimes(1);
    expect(f.control.finalize).not.toHaveBeenCalled(); expect(f.control.release).not.toHaveBeenCalled();
    expect((await f.send()).status).toBe(429);
  });

  it("returns incomplete at the total deadline when the terminal transport stays blocked", async () => {
    const f = fixture();
    let observedSignal: AbortSignal | undefined;
    f.control.terminal.mockImplementation(async (_task, signal) => { observedSignal = signal; await delay(60_000, signal); return {}; });
    await f.send();
    let result: unknown = "pending";
    const closing = f.service.close(deadline()).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(9000);
    expect(result).toBe(false); expect(observedSignal?.aborted).toBe(true);
    expect(f.control.finalize).not.toHaveBeenCalled(); expect(f.control.release).not.toHaveBeenCalled();
    expect(f.upstream).toHaveBeenCalledTimes(1);
    await closing;
  });

  it("never sends terminal proof for cancellation that remains unconfirmed", async () => {
    const cancellation = Promise.withResolvers<void>(); const f = fixture(() => cancellation.promise);
    await f.send(); let result: unknown = "pending";
    const closing = f.service.close(deadline()).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(9000);
    expect(result).toBe(false); expect(f.control.terminal).not.toHaveBeenCalled();
    cancellation.resolve(); await vi.advanceTimersByTimeAsync(1); await closing;
    expect(f.control.terminal).not.toHaveBeenCalled();
    expect(f.control.finalize).not.toHaveBeenCalled(); expect(f.control.release).not.toHaveBeenCalled();
  });

  it.each([MODEL, "claude-sonnet-5"])("reports %s original-body cancellation rejection incomplete without sending terminal proof", async (model) => {
    const f = fixture(async () => { throw new Error("Synthetic cancellation rejection"); }, model);
    await f.send();
    const closing = f.service.close(deadline());
    await vi.advanceTimersByTimeAsync(9000);
    expect(await closing).toBe(false);
    expect(f.control.terminal).not.toHaveBeenCalled();
    expect(f.control.finalize).not.toHaveBeenCalled(); expect(f.control.release).not.toHaveBeenCalled();
  });

  it.each([404, 409])("reports terminal HTTP %s rejection as incomplete", async (status) => {
    const f = fixture(); f.control.terminal.mockRejectedValue(Object.assign(new Error("rejected"), { status }));
    await f.send(); const closing = f.service.close(deadline());
    await vi.advanceTimersByTimeAsync(1);
    expect(await closing).toBe(false);
    expect(f.control.finalize).not.toHaveBeenCalled(); expect(f.control.release).not.toHaveBeenCalled();
  });

  it("retains an exact ACK rejection that occurs while another active cancellation is draining", async () => {
    const cancellation = Promise.withResolvers<void>(); const finalization = Promise.withResolvers<{}>();
    const f = fixture(() => cancellation.promise);
    f.control.finalize.mockImplementation(() => finalization.promise);
    f.upstream.mockImplementationOnce(async () => Response.json({ id: "exact-response", model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const first = await f.send(); await first.text();
    expect(f.control.finalize).toHaveBeenCalledTimes(1);
    expect((await f.send()).status).toBe(200);
    const closing = f.service.close(deadline());
    finalization.reject(Object.assign(new Error("Exact settlement rejected"), { status: 409 }));
    await vi.advanceTimersByTimeAsync(1);
    cancellation.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(await closing).toBe(false);
    expect(f.control.terminal).toHaveBeenCalledTimes(1);
    expect(f.control.finalize).toHaveBeenCalledTimes(1); expect(f.control.release).not.toHaveBeenCalled();
    expect(f.upstream).toHaveBeenCalledTimes(2);
  });

  it("confirms normal exact settlement without adding an unknown terminal outcome", async () => {
    const f = fixture();
    f.control.finalize.mockImplementation(async () => { await delay(2000); return {}; });
    f.upstream.mockImplementationOnce(async () => Response.json({ id: "exact-response", model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const response = await f.send(); await response.text();
    const closing = f.service.close(deadline());
    await vi.advanceTimersByTimeAsync(2000);
    expect(await closing).toBe(true);
    expect(f.control.finalize).toHaveBeenCalledTimes(1);
    expect(f.control.terminal).not.toHaveBeenCalled(); expect(f.control.release).not.toHaveBeenCalled();
  });

  it("does not renew the remaining budget for telemetry after a seven-second drain", async () => {
    const f = fixture(); f.control.terminal.mockImplementation(async (_task, signal) => { await delay(7000, signal); return {}; });
    tracker.shutdown.mockImplementation(() => delay(3000));
    await f.send(); let result: unknown = "pending";
    const closing = f.service.close(deadline()).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(9000);
    expect(result).toBe(false); expect(tracker.shutdown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); await closing;
    expect(result).toBe(false);
  });
});
