import { describe, expect, it, vi } from "vitest";
import { createBotModelRouteResolver, createSharedBotModelRouteResolver } from "../../../packages/gateway/src/bots/codex-route.js";
import { BotRouteError } from "../../../packages/gateway/src/bots/route-resolver.js";
const url = "https://chatgpt.com/backend-api/codex/responses";
describe("explicit owner Codex subscription bot route", () => {
  it("uses native owner subscription without consulting ordinary harness or funded catalogs", async () => {
    const getSnapshot = vi.fn(async () => { throw new Error("ordinary catalog unavailable"); });
    const resolve = createBotModelRouteResolver({ codexModel: "gpt-5.6-luna", providers: { getSnapshot },
      resolveCodexIdentity: async () => ({ url, headers: {} }), lifetime: new AbortController().signal });
    expect(await resolve()).toMatchObject({ accessSourceId: "owner_openai_profile", route: { api: "openai-responses", modelId: "gpt-5.6-luna" } });
    expect(getSnapshot).not.toHaveBeenCalled();
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


describe("explicit shared Pi policy route", () => {
  const decision = { policyRevision: "4", harness: "codex" as const, providerInstanceId: "codex_default", accessSourceId: null, allowedModelIds: ["gpt-5.6-luna"], effectiveSubmitMode: "members" as const };
  it("uses only the concrete model authorized by the company policy", async () => {
    const getSnapshot = vi.fn();
    const resolve = createSharedBotModelRouteResolver({ providers: { getSnapshot }, resolveCodexIdentity: async () => ({ url, headers: {} }), lifetime: new AbortController().signal });
    expect(await resolve(decision, "gpt-5.6-luna")).toMatchObject({ accessSourceId: "owner_openai_profile", route: { modelId: "gpt-5.6-luna" } });
    await expect(resolve(decision, "gpt-other")).rejects.toBeInstanceOf(BotRouteError);
    expect(getSnapshot).not.toHaveBeenCalled();
  });
});
