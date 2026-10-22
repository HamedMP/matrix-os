import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ScopeRuntimeBotInferenceRequest } from "@matrix-os/scope-runtime/broker-protocol";
import { forwardBotInference, type BotInferenceDependencies } from "../../packages/gateway/src/bots/broker-inference.js";
import type { ManagedPiRuntimeBinding } from "../../packages/gateway/src/bots/runtime-registry.js";
import { googleInferenceIdentity, prepareGoogleInferenceBody, type GoogleDataInferenceAuthority } from "../../packages/gateway/src/google-data/runtime/inference-policy.js";

const model = "selected-model";
const binding: ManagedPiRuntimeBinding = {
  kind: "managed_chat", runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "6", ownerId: "owner",
  chatId: "chat_google", runId: "run_google", workspace: { kind: "chat_workspace" }, rootFingerprint: "f".repeat(64),
  accessSourceId: "matrix_included", requestClass: "interactive", capabilities: ["artifact.read"],
  route: { api: "openai-completions", modelId: model, input: ["text"], contextWindow: 128_000, maxOutputTokens: 8192 },
};
const completion = () => ({ model, stream: true, messages: [{ role: "user", content: "synthetic Google text" }] });
const messages = () => ({ model, stream: true, max_tokens: 256, messages: [{ role: "user", content: "synthetic Google text" }] });
const responses = () => ({ model, stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "synthetic" }] }] });
function request(body: unknown = completion()): ScopeRuntimeBotInferenceRequest {
  return { version: 1, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle: binding.runtimeHandle,
    executionGeneration: binding.executionGeneration, action: "inference.chat_completions", method: "POST",
    path: "/v1/chat/completions", headers: {}, body: JSON.stringify(body) };
}
const accepted = { allowed: true, googleOrigin: true } as const;
function setup(authority: GoogleDataInferenceAuthority, overrides: Partial<BotInferenceDependencies> = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("synthetic output", { headers: { "content-type": "text/event-stream" } }));
  const deps: BotInferenceDependencies = { homePath: "/tmp", lifetime: new AbortController().signal, fetchImpl,
    resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic-credential", ANTHROPIC_BASE_URL: "https://relay.invalid/base" } }),
    googleData: authority, ...overrides };
  return { fetchImpl, deps, run: (body?: unknown) => forwardBotInference(request(body), binding,
    () => ({ allowed: true, accessSourceId: binding.accessSourceId, allowedModelIds: [model], allowedEgressOrigins: [] }), deps) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("Google inference typed wire policy", () => {
  it.each(["anthropic-messages", "openai-completions", "openai-responses"] as const)("accepts a bounded stateless %s payload", api => {
    const body = api === "anthropic-messages" ? messages() : api === "openai-completions" ? completion() : responses();
    const parsed = JSON.parse(prepareGoogleInferenceBody(api, JSON.stringify(body)));
    expect(parsed.model).toBe(model);
    if (api !== "anthropic-messages") expect(parsed.store).toBe(false);
  });
  it.each(["store", "metadata", "user", "prompt_cache_key", "prompt_cache_retention", "service_tier", "feedback", "background", "conversation", "previous_response_id"])("rejects completion control %s", field => {
    expect(() => prepareGoogleInferenceBody("openai-completions", JSON.stringify({ ...completion(), [field]: field === "store" ? true : "private" }))).toThrow();
  });
  it.each(["background", "previous_response_id", "conversation", "metadata", "prompt_cache_key", "include", "truncation"])("rejects Responses control %s", field => {
    expect(() => prepareGoogleInferenceBody("openai-responses", JSON.stringify({ ...responses(), [field]: "remote" }))).toThrow();
  });
  it.each([
    { type: "input_file", file_id: "file_remote" }, { type: "item_reference", id: "item_remote" },
    { type: "input_image", image_url: "https://remote.invalid/image" },
  ])("rejects remote Responses input %j", content => {
    expect(() => prepareGoogleInferenceBody("openai-responses", JSON.stringify({ ...responses(), input: [{ role: "user", content: [content] }] }))).toThrow();
  });
  it.each([{ type: "web_search" }, { type: "file_search", vector_store_ids: ["remote"] }, { type: "computer_use_preview" }, { type: "mcp", server_url: "https://remote.invalid" }])("rejects hosted tools %j", tool => {
    expect(() => prepareGoogleInferenceBody("openai-responses", JSON.stringify({ ...responses(), tools: [tool] }))).toThrow();
  });
  it("rejects Anthropic Files, unknown cache directives and request metadata", () => {
    for (const changed of [
      { ...messages(), metadata: { user_id: "private" } },
      { ...messages(), system: [{ type: "text", text: "private", cache_control: { type: "unknown" } }] },
      { ...messages(), messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file_remote" } }] }] },
      { ...messages(), tools: [{ type: "web_search_20250305", name: "web_search" }] },
    ]) expect(() => prepareGoogleInferenceBody("anthropic-messages", JSON.stringify(changed))).toThrow();
  });
  it("does not interpret tool input, tool output or JSON schema property names as configuration", () => {
    const data = { metadata: "business data", cache_control: "user text", previous_response_id: "row value", background: true };
    const body = { ...messages(), tools: [{ name: "read_rows", input_schema: { type: "object", properties: Object.fromEntries(Object.keys(data).map(key => [key, { type: "string" }])) } }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_rows", input: data }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: JSON.stringify(data) }] }] };
    expect(JSON.parse(prepareGoogleInferenceBody("anthropic-messages", JSON.stringify(body)))).toEqual(body);
  });
  it("rejects external JSON-schema references but preserves literal values and local references", () => {
    const withSchema = (parameters: unknown) => JSON.stringify({ ...completion(), tools: [{ type: "function", function: { name: "read", parameters } }] });
    expect(() => prepareGoogleInferenceBody("openai-completions", withSchema({ properties: { query: { $ref: "https://remote.invalid/schema" } } }))).toThrow();
    expect(() => prepareGoogleInferenceBody("openai-completions", withSchema({ $id: "https://remote.invalid/schema" }))).toThrow();
    expect(() => prepareGoogleInferenceBody("openai-completions", withSchema({ properties: { query: { $ref: "#/$defs/query" } }, $defs: { query: { type: "string", default: { $ref: "business data" } } } }))).not.toThrow();
  });
  it("never copies a credential-bearing URL into policy identity", () => {
    expect(() => googleInferenceIdentity(binding, "https://relay.invalid/?api_key=synthetic-credential", { kind: "api_key", value: "synthetic-credential" })).toThrow();
  });
});

describe("Google inference broker authority", () => {
  it("denies before network and supplies only the actual secret-free endpoint/credential identity", async () => {
    const authorize = vi.fn<GoogleDataInferenceAuthority["authorize"]>(async () => ({ allowed: false }));
    const fixture = setup({ authorize });
    expect(await fixture.run()).toMatchObject({ ok: false, error: "action_denied" });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    const input = authorize.mock.calls[0]![0];
    expect(input.identity).toMatchObject({ endpoint: "https://relay.invalid/base/v1/chat/completions", api: "openai-completions", modelId: model,
      credential: { kind: "auth_token", generation: null, fingerprint: createHash("sha256").update("synthetic-credential").digest("hex") } });
    expect(input.identity?.harnessVersion).toBeTruthy();
    expect(JSON.stringify(input)).not.toContain("synthetic-credential");
  });
  it("rewrites Google wire store:false but preserves ordinary request bytes", async () => {
    for (const googleOrigin of [true, false]) {
      const fixture = setup({ authorize: async () => ({ allowed: true, googleOrigin }) });
      const wire = { ...completion(), max_tokens: 123, ...(googleOrigin ? {} : { metadata: { ordinary: true }, store: true }) };
      expect(await fixture.run(wire)).toMatchObject({ ok: true });
      const sent = fixture.fetchImpl.mock.calls[0]![1]!.body as string;
      expect(sent).toBe(JSON.stringify(googleOrigin ? { ...wire, store: false } : wire));
    }
  });
  it("fails closed on policy error or invalid Google payload without provider fallback", async () => {
    for (const authorize of [async () => { throw new Error("private policy diagnostic"); }, async () => accepted]) {
      const fixture = setup({ authorize });
      const result = await fixture.run({ ...completion(), previous_response_id: "remote" });
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("private"); expect(fixture.fetchImpl).not.toHaveBeenCalled();
    }
  });
  it.each(["cancel", "binding"])("rechecks %s after asynchronous dispatch approval", async which => {
    const wait = deferred<typeof accepted>(); const entered = deferred<void>(); const controller = new AbortController(); let live = true;
    const fixture = setup({ authorize: async () => { entered.resolve(); return wait.promise; } }, {
      lifetime: controller.signal, revalidateBinding: async () => live,
    });
    const pending = fixture.run(); await entered.promise;
    if (which === "cancel") controller.abort(); else live = false;
    wait.resolve(accepted);
    expect(await pending).toMatchObject({ ok: false, error: "action_denied" }); expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
  it("rechecks policy after a funded queue wait and every capacity retry", async () => {
    let admitted = true; const authorize = vi.fn<GoogleDataInferenceAuthority["authorize"]>(async () => admitted ? accepted : { allowed: false });
    const fixture = setup({ authorize }, { fundedAdmission: { run: async (_input, callback) => {
      expect((await callback()).kind).toBe("busy"); admitted = false; return (await callback() as { kind: "done"; value: Response | "denied" }).value;
    } } as BotInferenceDependencies["fundedAdmission"] });
    fixture.fetchImpl.mockImplementation(async () => new Response("busy", { status: 429, headers: { "x-matrix-funded-reason": "busy" } }));
    expect(await fixture.run()).toMatchObject({ ok: false, error: "action_denied" });
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1); expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("refuses credential mismatch against the actual wire credential", async () => {
    const expected = createHash("sha256").update("old-credential").digest("hex");
    const fixture = setup({ authorize: async input => input.identity?.credential.fingerprint === expected ? accepted : { allowed: false } });
    expect(await fixture.run()).toMatchObject({ ok: false, error: "action_denied" }); expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
  it("rechecks policy on a first funded dispatch after queue admission", async () => {
    let admitted = true;
    const fixture = setup({ authorize: async () => admitted ? accepted : { allowed: false } }, { fundedAdmission: {
      run: async (_input, callback) => { admitted = false; return (await callback() as { kind: "done"; value: Response | "denied" }).value; },
    } as BotInferenceDependencies["fundedAdmission"] });
    expect(await fixture.run()).toMatchObject({ ok: false, error: "action_denied" }); expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects cache betas and leaves ordinary headers unchanged", async () => {
    for (const googleOrigin of [true, false]) {
      const candidate = { ...binding, accessSourceId: "owner_anthropic_key" as const,
        anthropicApi: { connectionRevision: 3, credentialGeneration: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1" },
        route: { ...binding.route, api: "anthropic-messages" as const } };
      const authorize = vi.fn<GoogleDataInferenceAuthority["authorize"]>(async () => ({ allowed: true, googleOrigin }));
      const fixture = setup({ authorize }, { matrixAnthropic: { revalidate: async () => true, credential: async () => "owner-key" } as never });
      const result = await forwardBotInference({ ...request(messages()), action: "inference.messages", path: "/v1/messages?beta=true",
        headers: { "anthropic-beta": "prompt-caching-2024-07-31" } }, candidate,
      () => ({ allowed: true, accessSourceId: candidate.accessSourceId, allowedModelIds: [model], allowedEgressOrigins: [] }), fixture.deps);
      expect(result.ok).toBe(!googleOrigin);
      const identity = authorize.mock.calls[0]![0].identity;
      expect(identity).toMatchObject({ endpoint: "https://api.anthropic.com/v1/messages?beta=true", credential: { kind: "api_key", generation: candidate.anthropicApi.credentialGeneration } });
      expect(JSON.stringify(identity)).not.toContain("owner-key");
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(googleOrigin ? 0 : 1);
    }
  });
  it("does not downgrade already-admitted Google provenance during response release", async () => {
    const fixture = setup({ authorize: async ({ phase }) => ({ allowed: true, googleOrigin: phase === "dispatch" }) });
    expect(await fixture.run()).toMatchObject({ ok: false, error: "action_denied" });
  });
  it.each(["policy", "binding", "cancel"])("withholds response on %s revocation during response approval", async which => {
    const entered = deferred<void>(); const wait = deferred<typeof accepted>(); const controller = new AbortController(); let live = true;
    const fixture = setup({ authorize: async ({ phase }) => { if (phase === "dispatch") return accepted; entered.resolve(); return wait.promise; } }, {
      lifetime: controller.signal, revalidateBinding: async () => live,
    });
    const pending = fixture.run(); await entered.promise;
    if (which === "binding") live = false; if (which === "cancel") controller.abort();
    wait.resolve(which === "policy" ? { allowed: false } as never : accepted);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: "action_denied" }); expect(JSON.stringify(result)).not.toContain("synthetic output");
    expect(fixture.fetchImpl).toHaveBeenCalledOnce();
  });
  it("does not bypass policy for delegated ChatGPT transport lacking actual recipient proof", async () => {
    const candidate = { ...binding, accessSourceId: "matrix_chatgpt_plan" as const, route: { ...binding.route, api: "openai-responses" as const },
      subscription: { peerId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", accountId: "local_ref", computerId: "computer", grantRevision: 1 } };
    const infer = vi.fn(); const authorize = vi.fn<GoogleDataInferenceAuthority["authorize"]>(async () => accepted);
    const fixture = setup({ authorize }, { chatgptPlan: { infer, revalidate: async () => true } as never });
    const result = await forwardBotInference({ ...request(responses()), action: "inference.responses", path: "/v1/responses" }, candidate,
      () => ({ allowed: true, accessSourceId: "matrix_chatgpt_plan", allowedModelIds: [model], allowedEgressOrigins: [] }), fixture.deps);
    expect(result).toMatchObject({ ok: false, error: "action_denied" }); expect(infer).not.toHaveBeenCalled();
    expect(authorize.mock.calls[0]![0].identity).toBeNull();
  });
  it.each(["policy", "route"])("rechecks %s before delegated ordinary response release", async revoked => {
    const candidate = { ...binding, accessSourceId: "matrix_chatgpt_plan" as const, route: { ...binding.route, api: "openai-responses" as const },
      subscription: { peerId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", accountId: "local_ref", computerId: "computer", grantRevision: 1 } };
    const completed = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", model } })}\n\n`;
    const infer = vi.fn(async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: completed }));
    let routeLive = true;
    const authorize = vi.fn<GoogleDataInferenceAuthority["authorize"]>(async ({ phase }) => {
      if (phase === "release") { if (revoked === "policy") return { allowed: false }; routeLive = false; }
      return { allowed: true, googleOrigin: false };
    });
    const fixture = setup({ authorize }, { chatgptPlan: { infer, revalidate: async () => true } as never });
    const result = await forwardBotInference({ ...request(responses()), action: "inference.responses", path: "/v1/responses" }, candidate,
      () => ({ allowed: true, accessSourceId: routeLive ? "matrix_chatgpt_plan" : "matrix_included", allowedModelIds: [model], allowedEgressOrigins: [] }), fixture.deps);
    expect(infer).toHaveBeenCalledOnce(); expect(result).toMatchObject({ ok: false, error: "action_denied" });
    expect(authorize.mock.calls.map(([input]) => input.phase)).toEqual(["dispatch", "dispatch", "release"]);
  });
  it("fails closed when delegated live-binding revalidation is unavailable", async () => {
    let checks = 0;
    const fixture = setup({ authorize: async () => ({ allowed: true, googleOrigin: false }) }, {
      revalidateBinding: async () => { if (++checks === 1) return true; throw new Error("private database failure"); },
      chatgptPlan: { infer: vi.fn(), revalidate: async () => true } as never,
    });
    const candidate = { ...binding, accessSourceId: "matrix_chatgpt_plan" as const, route: { ...binding.route, api: "openai-responses" as const } };
    await expect(forwardBotInference({ ...request(responses()), action: "inference.responses", path: "/v1/responses" }, candidate,
      () => ({ allowed: true, accessSourceId: "matrix_chatgpt_plan", allowedModelIds: [model], allowedEgressOrigins: [] }), fixture.deps)).resolves.toMatchObject({ ok: false });
  });
});
