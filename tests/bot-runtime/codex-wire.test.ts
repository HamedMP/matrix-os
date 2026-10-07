import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createBridgeModel, BROKER_PLACEHOLDER_KEY } from "../../packages/bot-runtime/src/providers.js";

describe("actual Pi Responses wire qualification (synthetic transport)", () => {
  it("records raw SDK input roles and tools without a private subscription bridge", async () => {
    const route = createBridgeModel({ api: "openai-responses", modelId: "gpt-5.6-luna", input: ["text", "image"], contextWindow: 128_000, maxOutputTokens: 8_192 }, "http://127.0.0.1:41000");
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ error: { message: "Synthetic transport stop after capturing wire format" } }), { status: 400, headers: { "content-type": "application/json" } });
    });
    await route.provider.streamSimple(route.model, normalizeContext({
      systemPrompt: "Write clearly.", messages: [{ role: "user", content: "READY", timestamp: Date.now() }],
      tools: [{ name: "artifact_write", description: "Save a QA artifact", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
    }), { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: 8192, fetch: fetchImpl, maxRetries: 0 }).result();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:41000/v1/responses");
    expect(body).toMatchObject({ model: "gpt-5.6-luna", stream: true, store: false, tools: [{ name: "artifact_write" }] });
    expect(JSON.stringify(body)).toContain("READY");
    // Raw SDK system roles do not prove compatibility with an approved Matrix SIWC endpoint.
    expect(body?.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system" })]));
  });
});
