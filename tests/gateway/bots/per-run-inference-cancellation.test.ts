import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createFundedAdmissionQueue } from "../../../packages/gateway/src/funded-ai/admission-queue.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import type { BotInferenceDependencies } from "../../../packages/gateway/src/bots/broker-inference.js";

const model = "@cf/zai-org/glm-5.3-flash";
const binding: ManagedPiRuntimeBinding = {
  kind: "managed_chat", runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "6",
  ownerId: "owner", chatId: "chat_funded", runId: "run_funded", workspace: { kind: "chat_workspace" },
  rootFingerprint: "f".repeat(64), accessSourceId: "matrix_included", requestClass: "interactive", capabilities: ["artifact.read"],
  route: { api: "openai-completions", modelId: model, input: ["text"], contextWindow: 128_000, maxOutputTokens: 8_192 },
};
const frame = (current = binding) => ({
  version: 1, action: "inference.chat_completions", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
  runtimeHandle: current.runtimeHandle, executionGeneration: current.executionGeneration,
  method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model, stream: true }),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(fetchImpl: typeof fetch, resolveCredentials = async () => ({ env: {
  ANTHROPIC_AUTH_TOKEN: "test-only", ANTHROPIC_BASE_URL: "https://relay.example.invalid",
} }), resolveCodexIdentity?: BotInferenceDependencies["resolveCodexIdentity"]) {
  const registry = new BotRuntimeRegistry(); registry.bind(binding);
  const queue = createFundedAdmissionQueue(); const lifetime = new AbortController();
  const actions = createBotBrokerActions({
    // Inference does not access repositories. Their interfaces are deliberately
    // absent here; an accidental dependency call fails instead of being mocked.
    db: {} as never, sessions: {} as never, checkpoints: {} as never,
    runs: {} as never, events: {} as never, tools: {} as never, registry,
    inference: { homePath: "/tmp", lifetime: lifetime.signal, fundedAdmission: queue, fetchImpl, resolveCredentials, resolveCodexIdentity },
  });
  return { registry, actions, queue, lifetime };
}

describe("run-owned broker inference cancellation", () => {
  it("never sends Codex inference after cancellation while owner identity resolves", async () => {
    let finish!: (value: { url: string; headers: { authorization: string; "chatgpt-account-id": string } }) => void;
    const resolveIdentity = vi.fn(async () => new Promise<{ url: string; headers: { authorization: string; "chatgpt-account-id": string } }>((resolve) => { finish = resolve; }));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("done"));
    const fixture = setup(fetchImpl, undefined, resolveIdentity);
    const codex = { ...binding, accessSourceId: "owner_openai_profile" as const,
      route: { ...binding.route, api: "openai-responses" as const, modelId: "gpt-5.6-luna" } };
    fixture.registry.bind(codex);
    try {
      const pending = fixture.actions.handleFrame({ ...frame(codex), action: "inference.responses", path: "/v1/responses",
        body: JSON.stringify({ model: codex.route.modelId, stream: true, input: [] }) });
      await vi.advanceTimersByTimeAsync(0); expect(resolveIdentity).toHaveBeenCalledTimes(1);
      fixture.registry.cancelInference(codex);
      finish({ url: "https://chatgpt.com/backend-api/codex/responses", headers: { authorization: "Bearer test-only", "chatgpt-account-id": "test-only" } });
      const result = await pending;
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, error: "action_denied" });
    } finally { fixture.queue.close(); fixture.registry.shutdown(); }
  });

  it.each([true, false])("canonical managed Stop aborts inference before worker cancellation (delivered=%s) and checks owner/chat", async (delivered) => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init!.signal!;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    const fixture = setup(fetchImpl);
    let finish!: (reply: unknown) => void;
    const runBot = vi.fn(async (input: { command: { kind: string } }) => {
      if (input.command.kind === "bot.cancel") {
        expect(signal?.aborted).toBe(true);
        expect(fixture.registry.lookupRun(binding)).toEqual(binding);
        return { ok: delivered, reply: {} };
      }
      return new Promise((resolve) => { finish = resolve; });
    });
    const snapshot = makeAiProviderSnapshot();
    const runtime = createManagedPiRuntime({
      admission: { admit: async () => binding, release: async (handle) => fixture.registry.release(handle), workspace: async () => "/owned/chat" },
      host: { client: { runBot } } as unknown as ScopeRuntimeHost,
      providers: { getSnapshot: async () => snapshot }, lifetime: fixture.lifetime.signal,
      forgetRun: (runId) => fixture.actions.forgetRun(runId), cancelInference: (current) => fixture.registry.cancelInference(current),
    });
    try {
      const input = { owner: { type: "personal" as const, ownerId: binding.ownerId }, chatId: binding.chatId, turnId: "cturn_cancel",
        runId: binding.runId, prompt: "Hello", parts: [{ type: "text" as const, text: "Hello" }],
        selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal };
      const iterator = runtime.adapter.start(input)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: "state.updated" });
      const pending = fixture.actions.handleFrame(frame());
      await vi.advanceTimersByTimeAsync(0);
      await runtime.adapter.cancel!({ ...input, owner: { type: "personal", ownerId: "other_owner" } });
      await runtime.adapter.cancel!({ ...input, chatId: "chat_other" });
      expect(signal?.aborted).toBe(false); expect(runBot).toHaveBeenCalledTimes(1);
      await runtime.adapter.cancel!(input);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      finish({ ok: true, reply: { runId: binding.runId, status: "cancelled", toolActions: 0, sessionRevision: 1 } });
      expect((await iterator.next()).value).toMatchObject({ type: "run.completed", outcome: "aborted" });
      await iterator.next();
    } finally { await runtime.close(); fixture.queue.close(); fixture.registry.shutdown(); }
  });

  it.each(["headers", "body"] as const)("aborts pending %s on release without waiting for the funded deadline or retrying", async (phase) => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init!.signal!; signal.throwIfAborted();
      if (phase === "headers") return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    const fixture = setup(fetchImpl);
    try {
      const pending = fixture.actions.handleFrame(frame());
      await vi.advanceTimersByTimeAsync(0); expect(fetchImpl).toHaveBeenCalledTimes(1);
      fixture.registry.release(binding.runtimeHandle);
      expect(signal?.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(fixture.lifetime.signal.aborted).toBe(false);
    } finally { fixture.queue.close(); fixture.registry.shutdown(); }
  });

  it("cancels a capacity wait before another paid send", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("busy", {
      status: 429, headers: { "x-matrix-funded-reason": "capacity_busy" },
    }));
    const fixture = setup(fetchImpl);
    try {
      const pending = fixture.actions.handleFrame(frame());
      await vi.advanceTimersByTimeAsync(0); expect(fetchImpl).toHaveBeenCalledTimes(1);
      fixture.registry.cancelInference(binding);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      await vi.advanceTimersByTimeAsync(1_000); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fixture.registry.lookupRun(binding)).toEqual(binding);
    } finally { fixture.queue.close(); fixture.registry.shutdown(); }
  });

  it("never sends after cancellation while credentials resolve", async () => {
    let finish!: (value: { env: { ANTHROPIC_AUTH_TOKEN: string; ANTHROPIC_BASE_URL: string } }) => void;
    const credentials = vi.fn(() => new Promise<{ env: { ANTHROPIC_AUTH_TOKEN: string; ANTHROPIC_BASE_URL: string } }>((resolve) => { finish = resolve; }));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("done", { headers: { "content-type": "text/event-stream" } }));
    const fixture = setup(fetchImpl, credentials);
    try {
      const pending = fixture.actions.handleFrame(frame());
      await vi.advanceTimersByTimeAsync(0); expect(credentials).toHaveBeenCalledTimes(1);
      fixture.registry.cancelInference(binding);
      finish({ env: { ANTHROPIC_AUTH_TOKEN: "test-only", ANTHROPIC_BASE_URL: "https://relay.example.invalid" } });
      await expect(pending).resolves.toMatchObject({ ok: false }); expect(fetchImpl).not.toHaveBeenCalled();
    } finally { fixture.queue.close(); fixture.registry.shutdown(); }
  });

  it("refuses new sends for a cancelled run but allows a newly bound run", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("done", { headers: { "content-type": "text/event-stream" } }));
    const fixture = setup(fetchImpl);
    try {
      fixture.registry.cancelInference(binding);
      await expect(fixture.actions.handleFrame(frame())).resolves.toMatchObject({ ok: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      const next = { ...binding, executionGeneration: "7", runId: "run_next" };
      fixture.registry.bind(next);
      fixture.registry.cancelInference(binding);
      await expect(fixture.actions.handleFrame(frame(next))).resolves.toMatchObject({ ok: true, body: "done" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.queue.close(); fixture.registry.shutdown(); }
  });
});
