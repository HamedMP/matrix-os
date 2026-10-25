import { describe, expect, it, vi } from "vitest";
import type { ScopeRuntimeBotInferenceRequest } from "@matrix-os/scope-runtime/broker-protocol";
import { SCOPE_RUNTIME_BOT_HARNESS_VERSION } from "@matrix-os/scope-runtime/bot-profile";
import { forwardBotInference, type BotInferenceDependencies } from "../../packages/gateway/src/bots/broker-inference.js";
import type { BotRuntimeBinding, ManagedPiRuntimeBinding, PiRuntimeBinding } from "../../packages/gateway/src/bots/runtime-registry.js";
import type { GoogleDataInferenceAuthority } from "../../packages/gateway/src/google-data/runtime/inference-policy.js";
import type { OrdinaryGenerationReceipt } from "../../packages/gateway/src/chat-analytics/index.js";

const MODEL = "measured-model";
const ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const common = { runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "3", ownerId: "owner_one",
  chatId: "chat_one", runId: "run_one", rootFingerprint: "f".repeat(64), accessSourceId: "matrix_included" as const,
  requestClass: "interactive" as const, capabilities: ["artifact.read" as const],
  route: { api: "openai-completions" as const, modelId: MODEL, input: ["text" as const], contextWindow: 128_000, maxOutputTokens: 4096 } };
const managed: ManagedPiRuntimeBinding = { ...common, kind: "managed_chat", workspace: { kind: "chat_workspace" } };
const bot: BotRuntimeBinding = { ...common, botId: "bot_one", taskId: "task_one" };
const body = { model: MODEL, stream: true, max_tokens: 128, messages: [{ role: "user", content: "Review this function" }] };
const plainReply = () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
// Broker-only DI fixture: real receipt forgery/replay is covered by runtime tests.
const fixtureReceipt = () => Object.freeze({}) as OrdinaryGenerationReceipt;
function request(value: unknown = body): ScopeRuntimeBotInferenceRequest {
  return { version: 1, requestId: ID, runtimeHandle: common.runtimeHandle, executionGeneration: common.executionGeneration,
    action: "inference.chat_completions", method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify(value) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup(options: { binding?: PiRuntimeBinding; googleData?: GoogleDataInferenceAuthority } = {}) {
  const binding = options.binding ?? bot;
  const controller = new AbortController();
  const receipts: OrdinaryGenerationReceipt[] = [];
  const analytics = {
    capture: vi.fn(async (_input: unknown) => { const receipt = fixtureReceipt(); receipts.push(receipt); return receipt; }),
    completed: vi.fn((_receipt: unknown, _facts: unknown) => undefined), cancel: vi.fn((_receipt: unknown) => undefined),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => plainReply());
  const allowed = vi.fn(() => ({ allowed: true, accessSourceId: binding.accessSourceId, allowedModelIds: [MODEL], allowedEgressOrigins: [] }));
  const deps = { homePath: "/tmp", lifetime: controller.signal, fetchImpl, chatAnalytics: analytics,
    revalidateBinding: vi.fn(async () => true),
    resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "fixture-key", ANTHROPIC_BASE_URL: "https://relay.example.test" } }),
    ...(options.googleData ? { googleData: options.googleData } : {}),
  } as BotInferenceDependencies & { chatAnalytics: typeof analytics };
  return { binding, controller, receipts, analytics, fetchImpl, allowed, deps,
    run: (value?: unknown) => forwardBotInference(request(value), binding, allowed, deps) };
}

describe("ordinary Chat analytics actual inference wiring", () => {
  it.each([bot, managed])("captures the exact final admitted generation and completes after response release for $runId", async binding => {
    const f = setup({ binding }); const order: string[] = [];
    f.deps.revalidateBinding = vi.fn(async () => { order.push("authorized"); return true; });
    f.analytics.capture.mockImplementation(async _input => { order.push("capture"); return fixtureReceipt(); });
    f.fetchImpl.mockImplementation(async () => { order.push("send"); return plainReply(); });
    f.analytics.completed.mockImplementation(() => { order.push("completed"); });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.analytics.capture).toHaveBeenCalledTimes(1);
    expect(f.analytics.capture.mock.calls[0]![0]).toMatchObject({ binding: {
      ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId,
      runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, requestId: ID,
    }, api: binding.route.api, body: f.fetchImpl.mock.calls[0]![1]!.body, signal: expect.any(AbortSignal) });
    const capturedBody = JSON.parse((f.analytics.capture.mock.calls[0]![0] as { body: string }).body);
    expect(capturedBody).toEqual(body);
    expect(order.indexOf("capture")).toBeGreaterThan(order.indexOf("authorized"));
    expect(order.indexOf("send")).toBeGreaterThan(order.indexOf("capture"));
    expect(order.indexOf("completed")).toBeGreaterThan(order.indexOf("send"));
    expect(f.analytics.completed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      modelId: MODEL, harness: SCOPE_RUNTIME_BOT_HARNESS_VERSION, accessSource: "matrix_included",
      inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null,
      latencyMs: expect.any(Number), completedAt: expect.any(String),
    }));
    expect(f.analytics.cancel).not.toHaveBeenCalled();
  });

  it("captures the broker-added output bound rather than stale worker bytes", async () => {
    const f = setup(); const { max_tokens: _omitted, ...withoutBound } = body;
    expect(await f.run(withoutBound)).toMatchObject({ ok: true });
    expect(JSON.parse((f.analytics.capture.mock.calls[0]![0] as { body: string }).body).max_tokens).toBe(common.route.maxOutputTokens);
  });

  it("never offers a Google-admitted body to the ordinary analytics hook", async () => {
    const f = setup({ googleData: { authorize: async () => ({ allowed: true, googleOrigin: true }) } });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.analytics.capture).not.toHaveBeenCalled();
    expect(f.analytics.completed).not.toHaveBeenCalled();
  });

  it("does not mistake absence of a Google authority for positive analytics permission", async () => {
    const f = setup(); f.analytics.capture.mockResolvedValue(null as never);
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.analytics.capture).toHaveBeenCalledTimes(1);
    expect(f.analytics.completed).not.toHaveBeenCalled(); expect(f.analytics.cancel).not.toHaveBeenCalled();
  });

  it.each(["cancel", "binding"])("rechecks %s after asynchronous capture before provider send", async mutation => {
    const f = setup(); const entered = deferred<void>(); const wait = deferred<OrdinaryGenerationReceipt>(); let live = true;
    f.deps.revalidateBinding = async () => live;
    f.analytics.capture.mockImplementation(async () => { entered.resolve(); return wait.promise; });
    const pending = f.run();
    await Promise.race([entered.promise, pending.then(() => { expect(f.analytics.capture).toHaveBeenCalledOnce(); })]);
    if (mutation === "cancel") f.controller.abort(); else live = false;
    const receipt = fixtureReceipt(); wait.resolve(receipt);
    expect(await pending).toMatchObject({ ok: false, error: "action_denied" });
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.analytics.completed).not.toHaveBeenCalled();
    expect(f.analytics.cancel).toHaveBeenCalledWith(receipt);
  });

  it("does not capture before funded queue admission and cancels a capacity-refused attempt", async () => {
    const f = setup(); let generation = 0;
    f.fetchImpl.mockImplementation(async () => ++generation === 1
      ? new Response("busy", { status: 429, headers: { "x-matrix-funded-reason": "slot_busy" } }) : plainReply());
    f.deps.fundedAdmission = { run: async (_input, send) => {
      expect(f.analytics.capture).not.toHaveBeenCalled();
      const busy = await send(); expect(busy.kind).toBe("busy");
      expect(f.analytics.cancel).toHaveBeenCalledWith(f.receipts[0]);
      const done = await send(); expect(done.kind).toBe("done"); return (done as { kind: "done"; value: Response }).value;
    } } as BotInferenceDependencies["fundedAdmission"];
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.analytics.capture).toHaveBeenCalledTimes(2);
    expect(f.analytics.completed).toHaveBeenCalledTimes(1);
    expect(f.analytics.completed.mock.calls[0]![0]).toBe(f.receipts[1]);
  });

  it.each(["http", "body", "release"])("cancels the exact receipt after primary %s failure", async failure => {
    const f = setup({ googleData: { authorize: async ({ phase }) => failure === "release" && phase === "release"
      ? { allowed: false } : { allowed: true, googleOrigin: false } } });
    if (failure === "http") f.fetchImpl.mockResolvedValue(new Response("upstream private error", { status: 502 }));
    if (failure === "body") f.fetchImpl.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error("truncated")); } })));
    expect((await f.run()).ok).toBe(false);
    expect(f.analytics.capture).toHaveBeenCalledTimes(1); expect(f.analytics.cancel).toHaveBeenCalledWith(f.receipts[0]);
    expect(f.analytics.completed).not.toHaveBeenCalled();
  });

  it("drops analytics when Google lineage appears at release, without changing allowed inference", async () => {
    const f = setup({ googleData: { authorize: async ({ phase }) => ({ allowed: true, googleOrigin: phase === "release" }) } });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.analytics.capture).toHaveBeenCalledTimes(1); expect(f.analytics.completed).not.toHaveBeenCalled();
    expect(f.analytics.cancel).toHaveBeenCalledWith(f.receipts[0]);
  });

  it.each(["capture", "completed", "cancel"])("keeps primary behavior independent of a failing %s hook", async hook => {
    const f = setup();
    if (hook === "capture") f.analytics.capture.mockRejectedValue(new Error("private analytics error"));
    if (hook === "completed") f.analytics.completed.mockImplementation(() => { throw new Error("private analytics error"); });
    if (hook === "cancel") {
      f.analytics.cancel.mockImplementation(() => { throw new Error("private analytics error"); });
      f.fetchImpl.mockResolvedValue(new Response("unavailable", { status: 502 }));
    }
    const result = await f.run(); expect(result.ok).toBe(hook !== "cancel");
    expect(JSON.stringify(result)).not.toContain("private analytics error");
  });

  it("does not cancel a successful captured generation when its primary runtime closes afterward", async () => {
    const f = setup(); expect(await f.run()).toMatchObject({ ok: true });
    expect(f.analytics.completed).toHaveBeenCalledTimes(1); f.controller.abort(); await Promise.resolve();
    expect(f.analytics.cancel).not.toHaveBeenCalled();
  });

  it("does not fabricate token counts or price from worker metadata or response extensions", async () => {
    const f = setup(); f.fetchImpl.mockResolvedValue(new Response("data: [DONE]\n\n", { headers: {
      "content-type": "text/event-stream", "x-cost-usd": "17", "x-input-tokens": "99",
    } }));
    expect(await f.run({ ...body, metadata: { costUsd: 17, inputTokens: 99 } })).toMatchObject({ ok: true });
    expect(f.analytics.completed.mock.calls[0]![1]).toMatchObject({ inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null });
  });

  it.each(["anthropic-messages", "openai-completions", "openai-responses"] as const)("records observed %s token facts without guessing a price", async api => {
    const binding: BotRuntimeBinding = { ...bot, route: { ...bot.route, api },
      ...(api === "anthropic-messages" ? { accessSourceId: "owner_anthropic_key" as const,
        anthropicApi: { connectionRevision: 1, credentialGeneration: "11111111-1111-4111-8111-111111111111" } }
        : api === "openai-responses" ? { accessSourceId: "owner_openai_key" as const,
          openaiApi: { connectionRevision: 1, credentialGeneration: "11111111-1111-4111-8111-111111111111" } } : {}) };
    const f = setup({ binding });
    if (api === "anthropic-messages") f.deps.matrixAnthropic = { revalidate: async () => true, credential: async () => "fixture-owner-key" } as never;
    if (api === "openai-responses") f.deps.matrixOpenAi = { revalidate: async () => true, credential: async () => "fixture-owner-key" } as never;
    const content = api === "anthropic-messages" ? [
      { type: "message_start", message: { model: MODEL, usage: { input_tokens: 11, cache_read_input_tokens: 3 } } },
      { type: "message_delta", usage: { output_tokens: 7 } }, { type: "message_stop" },
    ] : api === "openai-completions" ? [
      { model: MODEL, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 } } },
    ] : [{ type: "response.completed", response: { model: MODEL, status: "completed",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 } } } }];
    f.fetchImpl.mockResolvedValue(new Response(content.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } }));
    const req = api === "anthropic-messages" ? { ...request(), action: "inference.messages" as const, path: "/v1/messages" }
      : api === "openai-responses" ? { ...request(), action: "inference.responses" as const, path: "/v1/responses",
        body: JSON.stringify({ model: MODEL, stream: true, max_output_tokens: 128, input: [{ role: "user", content: "Review this function" }] }) } : request();
    expect(await forwardBotInference(req, binding, f.allowed, f.deps)).toMatchObject({ ok: true });
    expect(f.analytics.completed.mock.calls[0]![1]).toMatchObject({ modelId: MODEL, accessSource: binding.accessSourceId,
      inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, costUsd: null });
  });

  it.each([
    { model: "another-model", usage: { prompt_tokens: 11, completion_tokens: 7 } },
    { model: MODEL, usage: { prompt_tokens: -1, completion_tokens: 7 } },
    { model: MODEL, usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 12 } } },
    { model: MODEL, usage: { prompt_tokens: 11, completion_tokens: Number.MAX_SAFE_INTEGER + 1 } },
  ])("leaves malformed or mismatched token facts unknown %#", async response => {
    const f = setup(); f.fetchImpl.mockResolvedValue(new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } }));
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.analytics.completed.mock.calls[0]![1]).toMatchObject({ inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null });
  });
});
