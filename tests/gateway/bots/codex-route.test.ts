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

describe("explicit shared Pi policy route", () => {
  const decision = { policyRevision: "4", harness: "codex" as const, providerInstanceId: "codex_default", accessSourceId: null, allowedModelIds: ["gpt-5.6-luna"], effectiveSubmitMode: "members" as const };
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
    const policy = { ...decision, harness: "claude_code" as const, providerInstanceId: "claude_code_default", accessSourceId: "owner_anthropic_key", allowedModelIds: [modelId] };
    expect(await resolve(policy, modelId)).toMatchObject({ accessSourceId: "owner_anthropic_key", route: { api: "anthropic-messages", modelId } });
    await expect(resolve(policy, "claude-other")).rejects.toBeInstanceOf(BotRouteError);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(resolveCodexIdentity).not.toHaveBeenCalled();
  });
});
