import { describe, expect, it } from "vitest";
import { BROKER_PLACEHOLDER_KEY, createBridgeModel } from "../../packages/bot-runtime/src/providers.js";

const route = (api: "anthropic-messages" | "openai-responses" | "openai-completions") => ({
  api, modelId: api === "openai-completions" ? "@cf/zai-org/glm-5.3-flash" : "model-1",
  input: ["text", "image"] as ("text" | "image")[], contextWindow: 128_000, maxOutputTokens: 16_384,
});

describe("bot model routes", () => {
  it.each([
    ["anthropic-messages", "http://127.0.0.1:41000"],
    ["openai-responses", "http://127.0.0.1:41000/v1"],
    ["openai-completions", "http://127.0.0.1:41000/v1"],
  ] as const)("targets the loopback bridge for %s with image input and a placeholder key", async (api, baseUrl) => {
    const { provider, model } = createBridgeModel(route(api), "http://127.0.0.1:41000/");
    expect(model).toMatchObject({ api, baseUrl, input: ["text", "image"], maxTokens: 16_384 });
    expect(provider.getModels()).toEqual([model]);
    const auth = await provider.auth.apiKey!.resolve({ ctx: {} as never, signal: new AbortController().signal });
    expect(auth).toEqual({ auth: { apiKey: BROKER_PLACEHOLDER_KEY } });
  });

  it("refuses any non-loopback or credentialed bridge origin", () => {
    for (const origin of ["https://api.anthropic.com", "http://localhost:41000", "http://user:pw@127.0.0.1:41000", "http://127.0.0.1:41000/v1"]) {
      expect(() => createBridgeModel(route("anthropic-messages"), origin)).toThrow("Bot inference must use the loopback bridge");
    }
  });
});
