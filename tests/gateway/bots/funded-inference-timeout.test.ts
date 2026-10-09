import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeRuntimeBotInferenceRequest } from "@matrix-os/scope-runtime/broker-protocol";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createFundedAdmissionQueue } from "../../../packages/gateway/src/funded-ai/admission-queue.js";

const model = "@cf/zai-org/glm-5.3-flash";
const request: ScopeRuntimeBotInferenceRequest = {
  version: 1, action: "inference.chat_completions", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
  runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "6", method: "POST",
  path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model, stream: true, messages: [] }),
};
const binding: ManagedPiRuntimeBinding = {
  runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration,
  kind: "managed_chat", ownerId: "owner", chatId: "chat_funded", runId: "run_funded",
  workspace: { kind: "chat_workspace" }, rootFingerprint: "f".repeat(64), accessSourceId: "matrix_included",
  route: { api: "openai-completions", modelId: model, input: ["text"], contextWindow: 128_000, maxOutputTokens: 8_192 },
  capabilities: ["artifact.read"], requestClass: "interactive",
};
const authorization = { allowed: true, accessSourceId: "matrix_included", allowedModelIds: [model], allowedEgressOrigins: [] } as const;
const responseBody = 'data: {"choices":[{"delta":{"content":"Complete buffered reply."}}]}\n\ndata: [DONE]\n\n';
const response = () => new Response(responseBody, { headers: { "content-type": "text/event-stream" } });

beforeEach(() => {
  vi.useFakeTimers();
  // Node's native AbortSignal.timeout uses internal timers outside Vitest's
  // clock. Supply a timer-backed real AbortSignal; AbortSignal.any and abort
  // listeners stay real, so these tests exercise cancellation propagation.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), delay);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(delay = 31_000, immediateHeaders = false) {
  const lifetime = new AbortController();
  const fundedAdmission = createFundedAdmissionQueue();
  let signal: AbortSignal | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init!.signal!;
    signal.throwIfAborted();
    if (immediateHeaders) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            signal!.removeEventListener("abort", aborted);
            controller.enqueue(new TextEncoder().encode(responseBody));
            controller.close();
          }, delay);
          const aborted = () => { clearTimeout(timer); controller.error(signal!.reason); };
          signal!.addEventListener("abort", aborted, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { signal!.removeEventListener("abort", aborted); resolve(response()); }, delay);
      const aborted = () => { clearTimeout(timer); reject(signal!.reason); };
      signal!.addEventListener("abort", aborted, { once: true });
    });
  });
  const resolveCredentials = vi.fn(async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "test-only", ANTHROPIC_BASE_URL: "https://relay.example.invalid" } }));
  const revalidateBinding = vi.fn(async () => true);
  return { deps: { homePath: "/tmp", lifetime: lifetime.signal, fundedAdmission, fetchImpl, resolveCredentials, revalidateBinding },
    lifetime, fetchImpl, fundedAdmission, signal: () => signal };
}

describe("Pi Matrix funded inference deadline", () => {
  it("reads an SSE body completing after 31 seconds when fetch returns headers immediately", async () => {
    const fixture = setup(31_000, true);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      let settled = false; void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      expect(fixture.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ ok: true, status: 200, body: responseBody });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("aborts an unfinished SSE body at 120 seconds after immediate headers without retry", async () => {
    const fixture = setup(121_000, true);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      let settled = false; void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      expect(fixture.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toMatchObject({ name: "TimeoutError" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("cancels immediately while reading an SSE body after headers have returned", async () => {
    const fixture = setup(121_000, true);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      let settled = false; void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      fixture.lifetime.abort(new DOMException("Cancelled", "AbortError"));
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toBe(fixture.lifetime.signal.reason);
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("returns a complete buffered funded response after 31 seconds without a paid retry", async () => {
    const fixture = setup();
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ ok: true, status: 200, body: responseBody });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("aborts an unfinished funded request at 120 seconds and fails closed without retry", async () => {
    const fixture = setup(121_000);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(fixture.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toMatchObject({ name: "TimeoutError" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("propagates lifetime cancellation immediately instead of waiting for the funded deadline", async () => {
    const fixture = setup(121_000);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      await vi.advanceTimersByTimeAsync(1_000);
      fixture.lifetime.abort(new DOMException("Cancelled", "AbortError"));
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toBe(fixture.lifetime.signal.reason);
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it.each([429, 503])("never retries a provider %s response without the relay capacity marker", async (status) => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValue(new Response("provider error", { status }));
    try {
      await expect(forwardBotInference(request, binding, () => authorization, fixture.deps))
        .resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("retries only a marked relay capacity refusal before accepting a delayed response", async () => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValueOnce(new Response("busy", { status: 429,
      headers: { "x-matrix-funded-reason": "capacity_busy" } }));
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      await vi.advanceTimersByTimeAsync(31_250);
      await expect(pending).resolves.toMatchObject({ ok: true, body: responseBody });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(2);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("rechecks authority after a capacity wait and never sends a revoked second attempt", async () => {
    const fixture = setup();
    let allowed = true;
    fixture.fetchImpl.mockImplementationOnce(async () => {
      allowed = false;
      return new Response("busy", { status: 429, headers: { "x-matrix-funded-reason": "capacity_busy" } });
    });
    try {
      const pending = forwardBotInference(request, binding, () => allowed ? authorization : { allowed: false }, fixture.deps);
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "action_denied" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("retains the owner Anthropic credential deadline at 30 seconds", async () => {
    const fixture = setup();
    try {
      const ownerModel = "claude-sonnet-5";
      const ownerBinding = { ...binding, accessSourceId: "owner_anthropic_key" as const,
        route: { ...binding.route, api: "anthropic-messages" as const, modelId: ownerModel } };
      const pending = forwardBotInference({ ...request, action: "inference.messages", path: "/v1/messages",
        body: JSON.stringify({ model: ownerModel, stream: true, messages: [] }) }, ownerBinding,
        () => ({ ...authorization, accessSourceId: "owner_anthropic_key", allowedModelIds: [ownerModel] }),
        { ...fixture.deps, resolveCredentials: async () => ({ env: { ANTHROPIC_API_KEY: "test-only" } }) });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toMatchObject({ name: "TimeoutError" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });
});
