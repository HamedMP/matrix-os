import { describe, expect, it } from "vitest";
import { AggregateInputSchema, ChatAnalyticsTagsSchema, GenerationFactsSchema } from "../../packages/gateway/src/chat-analytics/contracts.js";
import { extractClassificationSnapshot } from "../../packages/gateway/src/chat-analytics/snapshot.js";

describe("ordinary Chat analytics contracts", () => {
  it.each([
    ["coding", "generate"], ["coding", "debug"], ["coding", "review"], ["coding", "explain"], ["coding", "refactor"], ["coding", "tests"],
    ["research", "lookup"], ["research", "compare"], ["research", "synthesis"],
    ["writing", "draft"], ["writing", "rewrite"], ["writing", "summarize"],
    ["translation", "translate"], ["planning", "plan"], ["data_analysis", "analyze"], ["question_answering", "answer"], ["other", "other"],
  ])("accepts only the fixed %s/%s taxonomy", (taskFamily, taskType) => {
    expect(ChatAnalyticsTagsSchema.parse({ taskFamily, taskType, complexity: "medium", confidence: 0.5 }))
      .toEqual({ taskFamily, taskType, complexity: "medium", confidence: 0.5 });
  });
  it.each([
    { taskFamily: "coding", taskType: "draft", complexity: "low" },
    { taskFamily: "coding", taskType: "debug", complexity: "genius" },
    { taskFamily: "coding", taskType: "debug", complexity: "high", confidence: 1.1 },
    { taskFamily: "coding", taskType: "debug", complexity: "high", confidence: Number.NaN },
    { taskFamily: "coding", taskType: "debug", complexity: "high", reason: "raw private text" },
    { taskFamily: "coding", taskType: "debug", complexity: "high", entities: ["private customer"] },
  ])("rejects invalid or content-bearing tags %#", value => {
    expect(ChatAnalyticsTagsSchema.safeParse(value).success).toBe(false);
  });
  it("bounds reporting dimensions and post-aggregation group limits", () => {
    const input = { ownerId: "owner_one", from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z",
      groupBy: ["taskFamily", "taskType", "modelId", "harness"], limit: 100 };
    expect(AggregateInputSchema.safeParse(input).success).toBe(true);
    expect(AggregateInputSchema.safeParse({ ...input, limit: 201 }).success).toBe(false);
    expect(AggregateInputSchema.safeParse({ ...input, groupBy: [...input.groupBy, "accessSource"] }).success).toBe(false);
  });
  it("keeps absent measurements null rather than inventing zero usage", () => {
    expect(GenerationFactsSchema.parse({ completedAt: "2026-10-25T14:00:00.000Z" })).toEqual({
      completedAt: "2026-10-25T14:00:00.000Z", modelId: null, harness: null, accessSource: null,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null, latencyMs: null,
    });
    expect(GenerationFactsSchema.safeParse({ completedAt: "2026-10-25T14:00:00.000Z", costUsd: -1 }).success).toBe(false);
  });
  it("takes an immutable exact-body snapshot of plain user/assistant text only", () => {
    const body = JSON.stringify({ model: "test-model", messages: [
      { role: "system", content: "system secret" }, { role: "user", content: "Please review this function" },
      { role: "tool", content: "tool secret" }, { role: "assistant", content: [{ type: "text", text: "Which function?" }] },
    ], tools: [{ secret: "schema secret" }] });
    const snapshot = extractClassificationSnapshot("openai-completions", body);
    expect(snapshot).toEqual({ messages: [
      { role: "user", text: "Please review this function" }, { role: "assistant", text: "Which function?" },
    ] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot!.messages)).toBe(true);
    expect(Object.isFrozen(snapshot!.messages[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });
  it.each(["anthropic-messages", "openai-responses"] as const)("supports bounded %s plain text", api => {
    const body = api === "anthropic-messages"
      ? { messages: [{ role: "user", content: [{ type: "text", text: "Translate this phrase" }] }] }
      : { input: [{ role: "user", content: [{ type: "input_text", text: "Translate this phrase" }] }] };
    expect(extractClassificationSnapshot(api, JSON.stringify(body)))
      .toEqual({ messages: [{ role: "user", text: "Translate this phrase" }] });
  });
  it("refuses malformed, multimodal-only, excessive and UTF-8-over-budget snapshots", () => {
    expect(extractClassificationSnapshot("openai-completions", "bad json")).toBeNull();
    expect(extractClassificationSnapshot("openai-completions", JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/private" } }] }] }))).toBeNull();
    expect(extractClassificationSnapshot("openai-completions", JSON.stringify({ messages: [{ role: "user", content: "🪵".repeat(10) }] }), 20)).toBeNull();
    expect(extractClassificationSnapshot("openai-completions", JSON.stringify({ messages: Array.from({ length: 129 }, () => ({ role: "user", content: "x" })) }))).toBeNull();
  });
});
