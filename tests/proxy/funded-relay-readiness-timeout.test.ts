import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FUNDED_AI_READINESS_TIMEOUTS } from "@matrix-os/contracts";
import { resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay-config.js";
import { FUNDED_GLM_FLASH } from "../../packages/proxy/src/funded-relay-model.js";
import { FUNDED_SONNET, probeFundedModel } from "../../packages/proxy/src/funded-relay-readiness.js";

function config() {
  return resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
    PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: "c".repeat(32), AI_RELAY_METADATA_SECRET: "m".repeat(32) })!;
}
function reply(model: string) {
  return Response.json(model === FUNDED_GLM_FLASH
    ? { success: true, result: { model, choices: [{ message: { content: "ok" } }] } }
    : { type: "message", model: "claude-sonnet-5", content: [{ type: "text", text: "ok" }] });
}

describe("funded generation readiness timeout budgets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Node's native AbortSignal.timeout uses timers outside Vitest's fake clock.
    // Adapt only the timer source so tests exercise the actual probe signal.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), delay);
      return controller.signal;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("leaves two seconds after upstream generation within the unchanged outer relay budget", () => {
    expect(FUNDED_AI_READINESS_TIMEOUTS.relayUpstreamProbeMs).toBe(8_000);
    expect(FUNDED_AI_READINESS_TIMEOUTS.relayProbeMs).toBe(10_000);
    expect(FUNDED_AI_READINESS_TIMEOUTS.relayProbeMs - FUNDED_AI_READINESS_TIMEOUTS.relayUpstreamProbeMs).toBe(2_000);
    expect(FUNDED_AI_READINESS_TIMEOUTS.platformRouteMs).toBe(12_000);
    expect(FUNDED_AI_READINESS_TIMEOUTS.gatewayRequestMs).toBe(13_000);
    expect(FUNDED_AI_READINESS_TIMEOUTS.gatewayObservationMs).toBe(14_000);
    expect(FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs).toBe(15_000);
  });

  it.each([FUNDED_GLM_FLASH, FUNDED_SONNET])("accepts a valid %s response after 6.29 seconds", async (model) => {
    let signal!: AbortSignal;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signal = init!.signal!;
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(reply(model)), 6_290);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    });
    let result: boolean | undefined;
    const pending = probeFundedModel(config(), model, fetchFn).then((value) => { result = value; return value; });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(result).toBeUndefined();
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_289);
    await expect(pending).resolves.toBe(true);
    expect(signal.aborted).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled upstream at eight seconds and returns unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let signal!: AbortSignal;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signal = init!.signal!;
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    let result: boolean | undefined;
    const pending = probeFundedModel(config(), FUNDED_GLM_FLASH, fetchFn).then((value) => { result = value; return value; });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(result).toBeUndefined();
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(false);
    expect(signal.aborted).toBe(true);
    expect(warn).toHaveBeenCalledWith("[funded-ai] Model readiness probe unavailable:", "TimeoutError");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
