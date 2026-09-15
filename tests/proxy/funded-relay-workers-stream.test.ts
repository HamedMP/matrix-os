import { describe, expect, it } from "vitest";
import { normalizeWorkersAiResponse } from "../../packages/proxy/src/funded-relay-workers-response.js";
import { createFundedUsageTracker } from "../../packages/proxy/src/funded-relay-usage.js";

const MODEL = "@cf/zai-org/glm-5.3-flash";
const summary = { prompt_tokens: 16, completion_tokens: 128, total_tokens: 144,
  prompt_tokens_details: { cached_tokens: 0 } };
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (choices: object[], usage: object) => event({ id: "live_1", model: MODEL,
  object: "chat.completion.chunk", created: 1789056858, choices, usage });
const emptyUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
function actualStream(includeSummary = true) {
  return chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    { ...emptyUsage, prompt_tokens: 16, total_tokens: 16 })
    + chunk([{ index: 0, delta: { reasoning_content: "Thinking" }, finish_reason: null }],
      { ...emptyUsage, completion_tokens: 8, total_tokens: 8 })
    + chunk([{ index: 0, delta: {}, finish_reason: "length" }], emptyUsage)
    + chunk([], emptyUsage)
    + (includeSummary ? event({ response: "", usage: summary }) : "") + "data: [DONE]\n\n";
}
describe("Workers AI model-in-path response normalization", () => {
  it.each([true, false])("never mistakes chunk deltas for final cumulative usage (summary=%s)", async (includeSummary) => {
    const normalized = normalizeWorkersAiResponse(new Response(actualStream(includeSummary), {
      headers: { "content-type": "text/event-stream" },
    }), MODEL, 10_000);
    const text = await normalized.text();
    const values = text.split("\n\n").filter((block) => block.startsWith("data: {")).map((block) => JSON.parse(block.slice(6)));
    const totals = values.filter((value) => value.usage != null);
    expect(totals).toHaveLength(includeSummary ? 1 : 0);
    if (includeSummary) expect(totals[0]).toMatchObject({ id: "live_1", model: MODEL, choices: [], usage: summary });
    expect(text).toContain("reasoning_content"); expect(text).not.toContain('"response"');
    const tracker = createFundedUsageTracker({ contentType: "text/event-stream", nativeModelId: MODEL,
      canonicalModelId: MODEL, pricingVersion: "cloudflare-2026-09-10-glm-flash" });
    tracker.push(new TextEncoder().encode(text));
    expect(tracker.complete()).toEqual(includeSummary ? { mode: "exact", actualCostMicrousd: 67 } : { mode: "conservative" });
  });
  it("unwraps successful synchronous Cloudflare response without exposing envelope metadata", async () => {
    const result = { id: "live_1", model: MODEL, object: "chat.completion", choices: [
      { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
    ], usage: summary };
    const normalized = normalizeWorkersAiResponse(Response.json({ success: true, result, errors: [], messages: [] }), MODEL, 10_000);
    expect(await normalized.json()).toEqual(result);
  });
});
