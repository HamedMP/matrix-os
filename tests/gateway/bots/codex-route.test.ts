import { describe, expect, it, vi } from "vitest";
import { createBotModelRouteResolver, createSharedBotModelRouteResolver } from "../../../packages/gateway/src/bots/codex-route.js";
import { BotRouteError } from "../../../packages/gateway/src/bots/route-resolver.js";
const url = "https://chatgpt.com/backend-api/codex/responses";
describe("explicit owner Codex subscription bot route", () => {
  it("blocks an operator Codex pin without consulting native identity or silently falling back", async () => {
    const getSnapshot = vi.fn(); const resolveCodexIdentity = vi.fn(async () => ({ url, headers: {} }));
    const resolve = createBotModelRouteResolver({ codexModel: "gpt-5.6-luna", providers: { getSnapshot }, resolveCodexIdentity, lifetime: new AbortController().signal });
    await expect(resolve()).rejects.toBeInstanceOf(BotRouteError); expect(getSnapshot).not.toHaveBeenCalled(); expect(resolveCodexIdentity).not.toHaveBeenCalled();
  });
  it.each(["https://api.openai.com/v1/responses", "https://example.com"])("rejects non-subscription identity %s without fallback", async (identityUrl) => {
    const getSnapshot = vi.fn();
    const resolve = createBotModelRouteResolver({ codexModel: "gpt-5.6-luna", providers: { getSnapshot },
      resolveCodexIdentity: async () => ({ url: identityUrl, headers: {} }), lifetime: new AbortController().signal });
    await expect(resolve()).rejects.toBeInstanceOf(BotRouteError);
    expect(getSnapshot).not.toHaveBeenCalled();
  });
  it("fails closed on invalid configured models and missing owner login", async () => {
    const identity = vi.fn(async () => { throw new Error("missing login"); });
    const options = { providers: { getSnapshot: vi.fn() }, resolveCodexIdentity: identity, lifetime: new AbortController().signal };
    await expect(createBotModelRouteResolver({ ...options, codexModel: "../bad" })()).rejects.toBeInstanceOf(BotRouteError);
    expect(identity).not.toHaveBeenCalled();
    await expect(createBotModelRouteResolver({ ...options, codexModel: "gpt-5.6-luna" })()).rejects.toBeInstanceOf(BotRouteError);
  });
});

it("an explicit managed model bypasses an operator Codex pin and never acquires subscription identity", async () => {
  const identity = vi.fn();
  const resolve = createBotModelRouteResolver({ codexModel: "gpt-5.6-luna", providers: { getSnapshot: async () => ({
    accessSources: [{ id: "matrix_cloudflare", state: "ready", staleAfter: null, eligibleModelIds: ["@cf/zai-org/glm-5.3-flash"] }],
    models: [{ id: "@cf/zai-org/glm-5.3-flash", vendor: "cloudflare", capabilities: ["tools"], status: "current", eligibleAccessSourceIds: ["matrix_cloudflare"] }],
  }) as never }, resolveCodexIdentity: identity, lifetime: new AbortController().signal });
  expect(await resolve({ instanceId: "matrix_pi_default", model: "@cf/zai-org/glm-5.3-flash" })).toMatchObject({ route: { api: "openai-completions", modelId: "@cf/zai-org/glm-5.3-flash" } });
  expect(identity).not.toHaveBeenCalled();
});

it("resolves a concrete Bot managed model without unrelated native discovery", async () => {
  const getSnapshot = vi.fn(async (options?: { admissionScope?: string }) => {
    if (options?.admissionScope !== "managed_matrix") throw new Error("Native inventory unavailable");
    return {
      accessSources: [{ id: "matrix_cloudflare", state: "ready", staleAfter: null, eligibleModelIds: ["@cf/zai-org/glm-5.3-flash"] }],
      models: [{ id: "@cf/zai-org/glm-5.3-flash", vendor: "cloudflare", capabilities: ["tools"], status: "current", eligibleAccessSourceIds: ["matrix_cloudflare"] }],
    } as never;
  });
  const resolve = createBotModelRouteResolver({ providers: { getSnapshot } });
  await expect(resolve({ instanceId: "matrix_pi_default", model: "@cf/zai-org/glm-5.3-flash" }))
    .resolves.toMatchObject({ accessSourceId: "matrix_included", route: { modelId: "@cf/zai-org/glm-5.3-flash" } });
});

describe("explicit shared Pi policy route", () => {
  const decision = { modelId: "gpt-5.6-luna", policyRevision: "4", harness: "codex" as const, providerInstanceId: "codex_default", accessSourceId: null, allowedModelIds: ["gpt-5.6-luna"], effectiveSubmitMode: "members" as const };
  it("keeps native Codex credentials out of the shared Pi coordinator", async () => {
    const getSnapshot = vi.fn();
    const resolveCodexIdentity = vi.fn(async () => ({ url, headers: {} }));
    const resolve = createSharedBotModelRouteResolver({ providers: { getSnapshot }, resolveCodexIdentity, lifetime: new AbortController().signal });
    await expect(resolve(decision, "gpt-5.6-luna")).rejects.toBeInstanceOf(BotRouteError);
    await expect(resolve(decision, "gpt-other")).rejects.toBeInstanceOf(BotRouteError);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(resolveCodexIdentity).not.toHaveBeenCalled();
  });
  it("uses the policy's exact ready source and model without owner defaults", async () => {
    const modelId = "claude-opus-4-6";
    const getSnapshot = vi.fn(async () => ({
      accessSources: [{ id: "owner_anthropic_key", state: "ready", staleAfter: null, eligibleModelIds: [modelId] }],
      models: [{ id: modelId, vendor: "anthropic", capabilities: ["tools"], status: "current", eligibleAccessSourceIds: ["owner_anthropic_key"] }],
    }) as never);
    const resolveCodexIdentity = vi.fn();
    const resolve = createSharedBotModelRouteResolver({ providers: { getSnapshot }, resolveCodexIdentity, lifetime: new AbortController().signal });
    const policy = { ...decision, modelId, harness: "claude_code" as const, providerInstanceId: "claude_code_default", accessSourceId: "owner_anthropic_key" as const, allowedModelIds: [modelId] };
    expect(await resolve(policy, modelId)).toMatchObject({ accessSourceId: "owner_anthropic_key", route: { api: "anthropic-messages", modelId } });
    await expect(resolve(policy, "claude-other")).rejects.toBeInstanceOf(BotRouteError);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(resolveCodexIdentity).not.toHaveBeenCalled();
  });
});

// ENG93: background class is server-owned and has no credential/funding fallback.
it("uses exact subscription background consent for a scheduled coordinator", async () => {
  const selection={instanceId:"matrix_chatgpt_plan",model:"fixture",options:[{id:"accountId",value:"fixture-account"},{id:"grantRevision",value:"3"}]};
  const source=vi.fn(async()=>({route:{api:"openai-responses",modelId:"fixture",input:["text"],contextWindow:1000,maxOutputTokens:100}} as never));
  const resolve=createBotModelRouteResolver({ownerId:"fixture-owner",providers:{getSnapshot:vi.fn()},chatgptPlan:{resolve:source} as never});
  await resolve(selection,"background");
  expect(source).toHaveBeenCalledWith(selection,"fixture-owner","background");
});
it("never funds a background routine through another source", async () => {
  const getSnapshot=vi.fn(),other=vi.fn();
  const resolve=createBotModelRouteResolver({ownerId:"fixture-owner",providers:{getSnapshot},matrixAnthropic:{resolve:other} as never});
  await expect(resolve(undefined,"background")).rejects.toBeInstanceOf(BotRouteError);
  await expect(resolve({instanceId:"matrix_anthropic_api",model:"fixture"},"background")).rejects.toBeInstanceOf(BotRouteError);
  expect(getSnapshot).not.toHaveBeenCalled();expect(other).not.toHaveBeenCalled();
});
