import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotProviderConnection, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { createRuntimeAppAiRoutes } from "../../packages/gateway/src/app-ai/runtime.js";
import { projectChatGptPlanSnapshot } from "../../packages/gateway/src/app-ai/chatgpt-plan-projection.js";
import type { ChatGptPlanAuthority } from "../../packages/gateway/src/bots/chatgpt-plan.js";
vi.mock("../../packages/gateway/src/request-principal.js", () => ({ requireRequestPrincipal: () => ({ userId: "owner" }) }));
let home: string;
const piRoute = { harnessId: "pi_work", accountId: null, accessSourceId: "pi_openai", modelId: "openai:fixture" };
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "app-u7-composition-")); await mkdir(join(home, "system")); await mkdir(join(home, ".pi/agent"), { recursive: true }); await writeFile(join(home, "system/app-ai.json"), JSON.stringify({ apps: ["notes"] })); await writeFile(join(home, ".pi/agent/auth.json"), JSON.stringify({ openai: { type: "oauth", access: "fixture-only", refresh: "fixture-refresh", expires: Date.now() + 60000 } })); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
function settings(): ProviderSettingsSnapshot {
  return { harnesses: [{ id: "pi_work", harness: "pi", displayName: "Pi", enabled: true, installState: "installed", authState: "authenticated", connectivity: "online", selectedAccountId: null, accessSourceId: "pi_openai", route: { kind: "configurable", providerId: "openai", modelId: "openai:fixture" } }], accounts: [], accessSources: [{ id: "pi_openai", kind: "harness_profile", harness: "pi", providerId: "openai", accountId: null, fundingKind: "harness_owned", eligibleModelIds: ["openai:fixture"], readiness: { state: "ready", staleAfter: null } }], modelProviders: [{ id: "openai", models: [{ id: "openai:fixture", displayName: "Fixture", enabled: true }] }] } as ProviderSettingsSnapshot;
}
it("advertises and executes Pi OAuth through the selected public SDK with no CLI fallback or recursive probe", async () => {
  const probe = vi.fn(async (input: { modelIds: string[] }) => input.modelIds);
  const generate = vi.fn(async (input: { revalidate: () => Promise<boolean> }) => { expect(await input.revalidate()).toBe(true); return { text: "SDK OAuth text" }; });
  const piSdkCompletion = { probe, generate, supports: vi.fn(), close: vi.fn() };
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSettingsReader: { getSnapshot: async () => settings() }, piSdkCompletion: piSdkCompletion as never });
  const discovery = await (await api.request("/routes?app=notes")).json();
  expect(discovery.routes[0]).toMatchObject({ ...piRoute, availability: "available" });
  const response = await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "supplied text", route: piRoute }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ text: "SDK OAuth text" });
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openai", modelId: "openai:fixture", prompt: "supplied text" }));
  expect(probe).toHaveBeenCalledTimes(2);
});
it("never falls back after an advertised SDK route fails", async () => {
  const piSdkCompletion = { probe: async () => [piRoute.modelId], generate: vi.fn(async () => { throw Error("SDK failed"); }), supports: vi.fn(), close: vi.fn() };
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSettingsReader: { getSnapshot: async () => settings() }, piSdkCompletion: piSdkCompletion as never });
  expect((await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "text", route: piRoute }) })).status).toBe(503);
});
const planRoute = { harnessId: "matrix_chatgpt_plan", accountId: "own-account", accessSourceId: "matrix_chatgpt_plan", modelId: "gpt-fixture" };
const observation: BotProviderConnection = { id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi", availability: "available", accountId: "own-account", models: [{ id: "gpt-fixture", displayName: "Fixture" }], authorization: { revision: 2, enabled: true, background: false }, coordinatorFunding: "subscription" };
function plan() {
  const canonical = projectChatGptPlanSnapshot({ contractVersion: 3, revision: 1, refreshedAt: new Date().toISOString(), accessSources: [], accounts: [], drivers: [], instances: [], models: [], active: { providerInstanceId: null, accessSourceId: null, modelId: null } }, observation);
  canonical.active = { providerInstanceId: "matrix_chatgpt_plan", accessSourceId: "matrix_chatgpt_plan", modelId: "gpt-fixture" };
  const authority: ChatGptPlanAuthority = {
    observe: vi.fn(async () => observation), resolve: vi.fn(async () => ({ accessSourceId: "matrix_chatgpt_plan", route: { api: "openai-responses", modelId: "gpt-fixture", input: ["text"], contextWindow: 32768, maxOutputTokens: 8192 }, subscription: { accountId: "own-account", peerId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2", computerId: "own-computer", grantRevision: 2 } })), revalidate: vi.fn(async () => true),
    infer: vi.fn(async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-fixture", status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "paired text" }] }] } })}\n\n` })),
  };
  return { canonical, authority };
}
it("derives paired plan default from common V3 and executes without native Settings harness", async () => {
  const fixture = plan();
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSnapshotReader: { getSnapshot: async () => fixture.canonical }, chatGptPlanSource: () => ({ ownerId: "owner", authority: fixture.authority }) });
  const discovery = await (await api.request("/routes?app=notes")).json();
  expect(discovery.defaultRoute).toEqual(planRoute);
  const response = await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "source" }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ text: "paired text" });
  expect(fixture.authority.infer).toHaveBeenCalledOnce();
});
it("keeps absent/mismatched paired owner unavailable", async () => {
  const fixture = plan();
  for (const chatGptPlanSource of [undefined, () => ({ ownerId: "other", authority: fixture.authority })]) {
    const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSnapshotReader: { getSnapshot: async () => fixture.canonical }, chatGptPlanSource });
    const discovery = await (await api.request("/routes?app=notes")).json();
    expect(discovery.defaultRoute).toBeNull();
    expect(discovery.routes[0]).toMatchObject({ availability: "unavailable" });
    expect((await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "source", route: planRoute }) })).status).toBe(503);
  }
  expect(fixture.authority.infer).not.toHaveBeenCalled();
});
it("isolates a failed Pi SDK readiness probe from unrelated managed AI routes", async () => {
  const canonical = { contractVersion: 3, revision: 1, refreshedAt: new Date().toISOString(), instances: [], active: { providerInstanceId: null, accessSourceId: null, modelId: null }, accessSources: [{ id: "matrix_cloudflare", state: "ready", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 60000).toISOString(), eligibleModelIds: ["managed-fixture"] }], models: [{ id: "managed-fixture", status: "current", eligibleAccessSourceIds: ["matrix_cloudflare"] }] } as never;
  const piSdkCompletion = { probe: async () => { throw Error("SDK missing"); }, generate: vi.fn(), supports: vi.fn(), close: vi.fn() };
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSettingsReader: { getSnapshot: async () => settings() }, providerSnapshotReader: { getSnapshot: async () => canonical }, piSdkCompletion: piSdkCompletion as never, fundedCredentialProvider: { enabled: true } as never });
  const response = await api.request("/routes?app=notes");
  expect(response.status).toBe(200);
  const discovery = await response.json();
  expect(discovery.routes).toContainEqual(expect.objectContaining({ accessSourceId: "matrix_cloudflare", availability: "available" }));
  expect(discovery.routes).toContainEqual(expect.objectContaining({ ...piRoute, availability: "unavailable" }));
});
it("honors removal from existing durable Settings while the Pi writer lease is held", async () => {
  let authorized: boolean | undefined;
  const generate = vi.fn(async (input: { revalidate: () => Promise<boolean> }) => {
    await mkdir(join(home, "system/ai-providers"), { recursive: true });
    await writeFile(join(home, "system/ai-providers/settings.json"), JSON.stringify({ schemaVersion: 1, revision: 2, harnesses: [], accountProfiles: [], gatewayPolicy: null, receipts: [] }));
    authorized = await input.revalidate();
    if (!authorized) throw Error("revoked");
    return { text: "must withhold" };
  });
  const piSdkCompletion = { probe: async () => [piRoute.modelId], generate, supports: vi.fn(), close: vi.fn() };
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSettingsReader: { getSnapshot: async () => settings() }, piSdkCompletion: piSdkCompletion as never });
  expect((await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "text", route: piRoute }) })).status).toBe(503);
  expect(authorized).toBe(false);
});
it("filters a fixed paired grant before unrelated Pi SDK readiness probes", async () => {
  const fixture = plan(); await writeFile(join(home, "system/app-ai.json"), JSON.stringify({ apps: ["notes"], route: planRoute }));
  const probe = vi.fn(async () => [piRoute.modelId]);
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSettingsReader: { getSnapshot: async () => settings() }, providerSnapshotReader: { getSnapshot: async () => fixture.canonical }, chatGptPlanSource: () => ({ ownerId: "owner", authority: fixture.authority }), piSdkCompletion: { probe, generate: vi.fn(), supports: vi.fn(), close: vi.fn() } as never });
  expect((await api.request("/routes?app=notes")).status).toBe(200); expect(probe).not.toHaveBeenCalled();
});
it("shares one bounded Pi profile/provider probe across harness instances", async () => {
  const snapshot = settings();
  snapshot.harnesses.push({ ...snapshot.harnesses[0]!, id: "second_pi", route: { ...snapshot.harnesses[0]!.route, modelId: "openai:second" } });
  snapshot.accessSources[0]!.eligibleModelIds.push("openai:second"); snapshot.modelProviders[0]!.models.push({ id: "openai:second", displayName: "Second", enabled: true });
  const probe = vi.fn(async (input: { modelIds: string[] }) => input.modelIds);
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSettingsReader: { getSnapshot: async () => snapshot }, piSdkCompletion: { probe, generate: vi.fn(), supports: vi.fn(), close: vi.fn() } as never });
  const response = await api.request("/routes?app=notes"); expect(response.status).toBe(200);
  expect(probe).toHaveBeenCalledOnce(); expect(probe).toHaveBeenCalledWith(expect.objectContaining({ modelIds: ["openai:fixture", "openai:second"] }));
});
it.each(["pi","opencode"] as const)("keeps a portable %s Matrix-funded route on exact metered HTTP access, never owner native auth", async harness => {
  const modelId = "@cf/zai-org/glm-5.3-flash";
  const route = { harnessId: "pi_work", accountId: null, accessSourceId: "matrix_cloudflare", modelId };
  const snapshot = settings();snapshot.harnesses[0]!.harness=harness; snapshot.harnesses[0]!.accessSourceId = route.accessSourceId; snapshot.harnesses[0]!.route = { kind: "configurable", providerId: "cloudflare", modelId };
  snapshot.accessSources = [{ id: route.accessSourceId, kind: "matrix_gateway", providerId: "cloudflare", accountId: null, fundingKind: "matrix_included", eligibleModelIds: [modelId], readiness: { state: "ready", staleAfter: null } }] as never;
  snapshot.modelProviders = [{ id: "cloudflare", displayName: "Cloudflare", models: [{ id: modelId, displayName: "GLM", enabled: true }] }];
  const probe = vi.fn(); const fetchImpl = vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "metered text" } }] }));
  const getCredential = vi.fn(async () => ({ token: "fixture-funding", relayBaseUrl: "https://relay.invalid" }));
  const canonical = { instances:[],active:{providerInstanceId:null,accessSourceId:null,modelId:null},accessSources:[{id:route.accessSourceId,state:"ready",checkedAt:new Date().toISOString(),staleAfter:new Date(Date.now()+60000).toISOString(),eligibleModelIds:[modelId]}],models:[{id:modelId,status:"current",eligibleAccessSourceIds:[route.accessSourceId]}] } as never;
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ["owner"], providerSnapshotReader:{getSnapshot:async()=>canonical},providerSettingsReader: { getSnapshot: async () => snapshot }, fundedCredentialProvider: { enabled: true, getCredential } as never, fetchImpl, piSdkCompletion: { probe, generate: vi.fn(), supports: vi.fn(), close: vi.fn() } as never });
  const response = await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "source", route }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ text: "metered text" });
  expect(getCredential).toHaveBeenCalledOnce(); expect(probe).not.toHaveBeenCalled();
  expect((fetchImpl.mock.calls[0]![1]!.headers as Headers).get("authorization")).toBe("Bearer fixture-funding");
  const stale=JSON.parse(JSON.stringify(canonical));stale.accessSources[0].staleAfter="2000-01-01T00:00:00.000Z";
  for(const providerSnapshotReader of [undefined,{getSnapshot:async()=>stale}]) {
    const denied=createRuntimeAppAiRoutes({homePath:home,ownerIds:["owner"],providerSettingsReader:{getSnapshot:async()=>snapshot},providerSnapshotReader,fundedCredentialProvider:{enabled:true,getCredential} as never,fetchImpl});
    expect((await denied.request("/",{method:"POST",body:JSON.stringify({app:"notes",prompt:"source",route})})).status).toBe(503);
  }
  expect(getCredential).toHaveBeenCalledOnce();expect(fetchImpl).toHaveBeenCalledOnce();
});
it('does not fall back to unaudited Pi CLI flags after SDK version/model discovery fails', async()=>{
  await writeFile(join(home,'.pi/agent/auth.json'),JSON.stringify({openai:{type:'api_key',key:'static-fixture'}}));
  for(const piSdkCompletion of [undefined,{probe:async()=>[],generate:vi.fn(),supports:vi.fn(),close:vi.fn()}]){
    const api=createRuntimeAppAiRoutes({homePath:home,ownerIds:['owner'],providerSettingsReader:{getSnapshot:async()=>settings()},piSdkCompletion:piSdkCompletion as never});
    const discovery=await(await api.request('/routes?app=notes')).json();expect(discovery.routes[0]).toMatchObject({availability:'unavailable'});
    expect((await api.request('/',{method:'POST',body:JSON.stringify({app:'notes',prompt:'text',route:piRoute})})).status).toBe(503);
  }
});
it('denies native OpenCode before inference when no exact no-tools runtime is audited', async()=>{
  await mkdir(join(home,'.local/share/opencode'),{recursive:true});await writeFile(join(home,'.local/share/opencode/auth.json'),JSON.stringify({openai:{type:'api',key:'fixture-only'}}));
  const snapshot=settings();snapshot.harnesses[0]!.harness='opencode';snapshot.accessSources[0]!.harness='opencode';
  const probe=vi.fn();const generate=vi.fn();const api=createRuntimeAppAiRoutes({homePath:home,ownerIds:['owner'],providerSettingsReader:{getSnapshot:async()=>snapshot},piSdkCompletion:{probe,generate,close:vi.fn()} as never});
  const discovery=await(await api.request('/routes?app=notes')).json();expect(discovery.routes[0]).toMatchObject({availability:'unavailable'});
  expect((await api.request('/',{method:'POST',body:JSON.stringify({app:'notes',prompt:'text',route:piRoute})})).status).toBe(503);expect(probe).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();
});
