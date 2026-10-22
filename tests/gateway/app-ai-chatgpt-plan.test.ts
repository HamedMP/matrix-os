import { afterEach, expect, it, vi } from "vitest";
import type { BotProviderConnection } from "@matrix-os/contracts";
import type { ChatGptPlanAuthority } from "../../packages/gateway/src/bots/chatgpt-plan.js";
import { generateChatGptPlanAppText } from "../../packages/gateway/src/app-ai/chatgpt-plan-completion.js";
import { projectChatGptPlanSnapshot } from "../../packages/gateway/src/app-ai/chatgpt-plan-projection.js";

const route = { harnessId: "matrix_chatgpt_plan", accountId: "account_own", accessSourceId: "matrix_chatgpt_plan", modelId: "gpt-account-model" };
const source: BotProviderConnection = { id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi", availability: "available", accountId: "account_own", models: [{ id: route.modelId, displayName: "Account model" }], authorization: { revision: 4, enabled: true, background: false }, coordinatorFunding: "subscription" };
const base = { contractVersion: 3 as const, revision: 0, refreshedAt: new Date().toISOString(), accessSources: [], accounts: [], drivers: [], instances: [], models: [], active: { providerInstanceId: null, accessSourceId: null, modelId: null } };
const event = (type: string, extra: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const message = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Summary" }] };
function completed(output: unknown[] = [message], model = route.modelId) { return event("response.completed", { response: { status: "completed", model, output } }); }
function fixture(body = event("response.output_text.delta", { delta: "Summary" }) + completed()) {
  const authority: ChatGptPlanAuthority = {
    observe: vi.fn(async () => source),
    resolve: vi.fn(async () => ({ accessSourceId: "matrix_chatgpt_plan", route: { api: "openai-responses", modelId: route.modelId, input: ["text"], contextWindow: 128000, maxOutputTokens: 8192 }, subscription: { accountId: "account_own", peerId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2", computerId: "computer-own", grantRevision: 4 } })),
    revalidate: vi.fn(async () => true),
    infer: vi.fn(async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body })),
  };
  return { authority, options: { ownerId: "owner", app: "brain", route, authority, canonical: projectChatGptPlanSnapshot(base, source), prompt: "Read supplied notes", signal: new AbortController().signal, revalidate: vi.fn(async () => true) } };
}
afterEach(() => vi.useRealTimers());

it("roundtrips exact owner/account/model through secretless text-only authority", async () => {
  const f = fixture();
  expect(await generateChatGptPlanAppText(f.options)).toEqual({ text: "Summary" });
  expect(f.authority.observe).toHaveBeenCalledWith("owner");
  expect(f.authority.resolve).toHaveBeenCalledWith({ instanceId: "matrix_chatgpt_plan", model: route.modelId, options: [{ id: "accountId", value: "account_own" }, { id: "grantRevision", value: "4" }] }, "owner", "interactive");
  const [binding, serialized] = vi.mocked(f.authority.infer).mock.calls[0]!;
  expect(binding).toMatchObject({ ownerId: "owner", accessSourceId: "matrix_chatgpt_plan", capabilities: [], requestClass: "interactive", subscription: { accountId: "account_own", grantRevision: 4 } });
  expect(JSON.parse(serialized)).toEqual({ model: route.modelId, stream: true, store: false, instructions: expect.any(String), input: [{ role: "user", content: "Read supplied notes" }] });
  for (const key of ["tools", "previous_response_id", "conversation", "authorization"]) expect(JSON.parse(serialized)).not.toHaveProperty(key);
});
it("consumes a local mock authority's chunked SSE roundtrip", async () => {
  const f = fixture();
  const body = event("response.output_text.delta", { delta: "Summary" }) + completed();
  vi.mocked(f.authority.infer).mockImplementation(async (_binding, _body, signal) => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let i = 0; i < body.length; i += 7) controller.enqueue(new TextEncoder().encode(body.slice(i, i + 7)));
      controller.close();
    } });
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    signal.throwIfAborted();
    return { status: response.status, headers: { "content-type": response.headers.get("content-type")! }, body: await response.text() };
  });
  expect(await generateChatGptPlanAppText(f.options)).toEqual({ text: "Summary" });
});
it.each([
  { ...route, accountId: "another" }, { ...route, modelId: "another" }, { ...route, harnessId: "codex" }, { ...route, accessSourceId: "owner_openai_profile" },
])("rejects a selection outside canonical owner route", async selected => {
  const f = fixture();
  await expect(generateChatGptPlanAppText({ ...f.options, route: selected })).rejects.toThrow("App AI is unavailable");
  expect(f.authority.infer).not.toHaveBeenCalled();
});
it("does not infer without canonical projection or fresh readiness", async () => {
  const f = fixture();
  await expect(generateChatGptPlanAppText({ ...f.options, canonical: base })).rejects.toThrow("App AI is unavailable");
  f.options.canonical.accessSources[0]!.staleAfter = "2000-01-01T00:00:00.000Z";
  await expect(generateChatGptPlanAppText(f.options)).rejects.toThrow("App AI is unavailable");
  expect(f.authority.infer).not.toHaveBeenCalled();
});
it("fails closed on disabled authority and changed exact resolved account", async () => {
  const f = fixture();
  vi.mocked(f.authority.observe).mockResolvedValueOnce({ ...source, availability: "setup_required", unavailableReason: "authorization_required", authorization: { ...source.authorization, enabled: false } });
  await expect(generateChatGptPlanAppText(f.options)).rejects.toThrow("App AI is unavailable");
  const resolved = await f.authority.resolve({ instanceId: "matrix_chatgpt_plan", model: route.modelId }, "owner", "interactive");
  vi.mocked(f.authority.resolve).mockResolvedValueOnce({ ...resolved, subscription: { ...resolved.subscription!, accountId: "other" } });
  await expect(generateChatGptPlanAppText(f.options)).rejects.toThrow("App AI is unavailable");
  expect(f.authority.infer).not.toHaveBeenCalled();
});
it.each(["app", "authority"])("rechecks %s permission before sending and after receiving", async kind => {
  const f = fixture();
  const predicate = kind === "app" ? f.options.revalidate : vi.mocked(f.authority.revalidate);
  predicate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(generateChatGptPlanAppText(f.options)).rejects.toThrow("App AI is unavailable");
});
it.each([
  event("response.output_text.delta", { delta: "Partial" }), event("response.failed"), completed([], "wrong"), completed() + event("error"),
  completed([{ type: "function_call", name: "read_file", arguments: "{}" }]),
  event("response.output_item.added", { item: { type: "function_call", name: "read_file" } }) + completed(),
  completed([{ ...message, content: [{ type: "refusal", refusal: "No" }] }]),
  completed([{ ...message, content: [{ type: "output_text", text: "x".repeat(64001) }] }]),
  "x".repeat(1024 * 1024 + 1),
])("never returns partial, tool, malformed, or oversized SSE", async body => {
  const f = fixture(body);
  await expect(generateChatGptPlanAppText(f.options)).rejects.toThrow("App AI is unavailable");
});
it("bounds authority waits even when a mock ignores abort", async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.authority.infer).mockImplementation(() => new Promise(() => {}));
  const result = generateChatGptPlanAppText(f.options);
  const rejected = expect(result).rejects.toThrow("App AI is unavailable");
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
  expect(vi.mocked(f.authority.infer).mock.calls[0]![2].aborted).toBe(true);
});
it("cancels the authority and returns only safe errors", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.options.signal = controller.signal;
  vi.mocked(f.authority.infer).mockImplementation(async (_binding, _body, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private token/path/provider")), { once: true })));
  const result = generateChatGptPlanAppText(f.options);
  const rejected = expect(result).rejects.toThrow("App AI is unavailable");
  await vi.waitFor(() => expect(f.authority.infer).toHaveBeenCalled());
  controller.abort();
  await rejected;
});
