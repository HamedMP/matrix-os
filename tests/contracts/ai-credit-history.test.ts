import { describe, expect, it } from "vitest";
import { AiCreditHistoryResponseSchema } from "../../packages/contracts/src/ai-credit-history.js";

describe("AI credit history model identifiers", () => {
  const page = (modelId: string | null) => ({
    entries: [{ occurredAt: "2026-10-01T00:00:00.000Z", kind: "usage", amountMicrousd: -111, modelId }],
    nextCursor: null,
  });
  it.each(["@cf/zai-org/glm-5.3-flash", "anthropic/claude-sonnet-5", "@cf/" + "a".repeat(156), null])("accepts the authoritative model %s", model => {
    expect(AiCreditHistoryResponseSchema.safeParse(page(model)).success).toBe(true);
  });
  it.each(["@evil/model", "@cf/", "@cf/<private>", "@cf/model with spaces", "@cf/" + "a".repeat(157), "@cf/model\n", "@cf/model\r\n", "@cf/@cf/model", ""])("rejects unsafe or unbounded model %s", model => {
    expect(AiCreditHistoryResponseSchema.safeParse(page(model)).success).toBe(false);
  });
});
