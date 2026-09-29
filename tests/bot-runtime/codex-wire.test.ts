import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createBridgeModel, BROKER_PLACEHOLDER_KEY } from "../../packages/bot-runtime/src/providers.js";
import { codexSubscriptionBody } from "../../packages/gateway/src/bots/codex-inference.js";

describe("actual Pi Responses subscription wire format", () => {
  it("normalizes the installed Pi SDK's request without dropping its tools or user input", async () => {
    const route = createBridgeModel({ api: "openai-responses", modelId: "gpt-5.6-luna", input: ["text", "image"], contextWindow: 128_000, maxOutputTokens: 8_192 }, "http://127.0.0.1:41000");
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(codexSubscriptionBody(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: "Synthetic transport stop after capturing wire format" } }), { status: 400, headers: { "content-type": "application/json" } });
    });
    await route.provider.streamSimple(route.model, normalizeContext({
      systemPrompt: "Write clearly.", messages: [{ role: "user", content: "READY", timestamp: Date.now() }],
      tools: [{ name: "artifact_write", description: "Save a QA artifact", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
    }), { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: 8192, fetch: fetchImpl, maxRetries: 0 }).result();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ model: "gpt-5.6-luna", stream: true, store: false, instructions: "Write clearly.", tools: [{ name: "artifact_write" }] });
    expect(JSON.stringify(body)).toContain("READY");
    expect(body?.max_output_tokens).toBeUndefined();
  });
});
