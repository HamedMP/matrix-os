import { expect, it, vi } from "vitest";
import { resolveManagedPiSelection, sameManagedPiRoute } from "../../../packages/gateway/src/chat/managed-pi-route.js";
import { createBotModelRouteResolver } from "../../../packages/gateway/src/bots/codex-route.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
const gen = "e16625fe-cad7-4983-a9db-e808bbf104cc";
const selection = { instanceId: "matrix_pi_anthropic_api", model: "claude-model", options: [{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: gen }] };
const resolved = { route: { api: "anthropic-messages" as const, modelId: "claude-model", input: ["text" as const], contextWindow: 200000, maxOutputTokens: 8192 }, accessSourceId: "owner_anthropic_key" as const, anthropicApi: { connectionRevision: 3, credentialGeneration: gen } };
const binding = { ...resolved, runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", ownerId: "owner", botId: "bot_0123456789abcdef", chatId: "chat_api", taskId: "task_api", runId: "run_api", rootFingerprint: "b".repeat(64), capabilities: ["artifact.read" as const], requestClass: "interactive" as const };
const request = { version: 1 as const, requestId: "c8fce10f-b83e-4cd6-bde7-226f1629fcb6", runtimeHandle: binding.runtimeHandle, executionGeneration: "1", action: "inference.messages" as const, path: "/v1/messages", method: "POST" as const, headers: { "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-model", stream: true, messages: [] }) };
function fixture() {
 const providers = { getSnapshot: vi.fn(async () => { throw new Error("Funding fallback forbidden"); }) };
 const matrixAnthropic = { observe: vi.fn(), resolve: vi.fn(async () => resolved), credential: vi.fn(async () => "owner-secret"), revalidate: vi.fn(async () => true) };
 return { providers, matrixAnthropic };
}
it("resolves both explicit chat and recipe sources without funded lookup and rejects malformed or mismatched authority", async () => {
 const f = fixture(); expect(await resolveManagedPiSelection(selection, "owner", f)).toEqual(resolved);
 expect(f.matrixAnthropic.resolve).toHaveBeenCalledWith(selection, "owner", "interactive");
 expect(await createBotModelRouteResolver({ ...f, ownerId: "owner" })({ ...selection, instanceId: "matrix_anthropic_api" })).toEqual(resolved);
 expect(f.providers.getSnapshot).not.toHaveBeenCalled();
 await expect(resolveManagedPiSelection({ ...selection, options: [] }, "owner", f)).rejects.toThrow();
 f.matrixAnthropic.resolve.mockResolvedValue({ ...resolved, anthropicApi: { ...resolved.anthropicApi, connectionRevision: 4 } });
 await expect(resolveManagedPiSelection(selection, "owner", f)).rejects.toThrow();
 expect(sameManagedPiRoute(resolved, { ...resolved, anthropicApi: { ...resolved.anthropicApi, connectionRevision: 4 } })).toBe(false);
});
it("binds API generation only on an owner Anthropic Messages route", () => {
 const registry = new BotRuntimeRegistry(); registry.bind(binding);
 expect(registry.lookupRun(binding)?.anthropicApi).toEqual(resolved.anthropicApi);
 for (const change of [{ accessSourceId: "matrix_included" }, { subscription: { peerId: gen, accountId: "a", computerId: "c", grantRevision: 1 } }, { anthropicApi: { ...resolved.anthropicApi, connectionRevision: 0 } }]) expect(() => registry.bind({ ...binding, ...change } as typeof binding)).toThrow();
 registry.shutdown();
});
it("uses only exact qualified owner key and checks generation before every inference, including continuations", async () => {
 const f = fixture(); const fetcher = vi.fn<typeof fetch>(async () => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
 const resolveCredentials = vi.fn(async () => { throw new Error("Ambient key fallback forbidden"); });
 const registry = new BotRuntimeRegistry(); registry.bind(binding);
 const authorize = (modelId: string) => registry.authorize({ ...binding, modelId, action: request.action });
 const deps = { homePath: "/unused", matrixAnthropic: f.matrixAnthropic, lifetime: new AbortController().signal, fetchImpl: fetcher, resolveCredentials };
 expect((await forwardBotInference(request, binding, authorize, deps)).ok).toBe(true);
 expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
 expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("x-api-key")).toBe("owner-secret");
 expect(resolveCredentials).not.toHaveBeenCalled();
 f.matrixAnthropic.revalidate.mockResolvedValue(false);
 expect((await forwardBotInference(request, binding, authorize, deps)).ok).toBe(false);
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect((await forwardBotInference(request, binding, authorize, { ...deps, matrixAnthropic: undefined })).ok).toBe(false);
 registry.shutdown();
});
it("retains the saved API source through recipe coordinator projection without treating it as funded", async () => {
 const { recipeCoordinatorSelection } = await import("../../../packages/gateway/src/bots/coordinator-selection.js");
 const recipe = { ...selection, instanceId: "matrix_anthropic_api" };
 expect(recipeCoordinatorSelection({ ...recipe, instanceId: "matrix_bot_default" }, recipe)).toEqual(recipe);
 expect(recipeCoordinatorSelection({ instanceId: "matrix_bot_default", model: "auto" }, recipe)).toEqual(recipe);
 expect(() => recipeCoordinatorSelection({ ...recipe, options: [recipe.options[0]!] }, recipe)).toThrow();
 expect(() => recipeCoordinatorSelection({ ...recipe, instanceId: "unrelated" }, recipe)).toThrow();
});

it.each([true, false])("preserves ordinary capability qualification when rootChat is %s and recipe capability differs", async rootChat => {
 const f = fixture();
 f.matrixAnthropic.resolve.mockImplementation(async selected => {
   const allowed = selected.instanceId === "matrix_pi_anthropic_api" ? rootChat : !rootChat;
   if (!allowed) throw new Error("This surface is unsupported");
   return resolved;
 });
 const pending = resolveManagedPiSelection(selection, "owner", f);
 if (rootChat) expect(await pending).toEqual(resolved); else await expect(pending).rejects.toThrow();
 expect(f.providers.getSnapshot).not.toHaveBeenCalled();
});
it("rejects a late paid response after the admitted API source is revoked", async () => {
 const f = fixture(), registry = new BotRuntimeRegistry(); registry.bind(binding);
 let complete!: (response: Response) => void;
 const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { complete = resolve; }));
 const pending = forwardBotInference(request, binding, modelId => registry.authorize({ ...binding, modelId, action: request.action }), { homePath: "/unused", matrixAnthropic: f.matrixAnthropic, lifetime: new AbortController().signal, runSignal: registry.inferenceSignal(binding)!, fetchImpl: fetcher });
 await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
 f.matrixAnthropic.revalidate.mockResolvedValue(false); registry.cancelAnthropicInference();
 complete(new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
 expect((await pending).ok).toBe(false); registry.shutdown();
});
