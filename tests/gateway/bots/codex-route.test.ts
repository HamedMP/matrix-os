import { describe, expect, it, vi } from "vitest";
import { createBotModelRouteResolver } from "../../../packages/gateway/src/bots/codex-route.js";
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

it("an explicit managed model bypasses an operator Codex pin and never acquires subscription identity", async () => {
  const identity = vi.fn();
  const resolve = createBotModelRouteResolver({ codexModel: "gpt-5.6-luna", providers: { getSnapshot: async () => ({
    accessSources: [{ id: "matrix_cloudflare", state: "ready", staleAfter: null, eligibleModelIds: ["@cf/zai-org/glm-5.3-flash"] }],
    models: [{ id: "@cf/zai-org/glm-5.3-flash", vendor: "cloudflare", capabilities: ["tools"], status: "current", eligibleAccessSourceIds: ["matrix_cloudflare"] }],
  }) as never }, resolveCodexIdentity: identity, lifetime: new AbortController().signal });
  expect(await resolve({ instanceId: "matrix_pi_default", model: "@cf/zai-org/glm-5.3-flash" })).toMatchObject({ route: { api: "openai-completions", modelId: "@cf/zai-org/glm-5.3-flash" } });
  expect(identity).not.toHaveBeenCalled();
});
