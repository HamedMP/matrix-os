import { describe, expect, it } from "vitest";
import { normalizeCodexModelCatalog } from "../../packages/gateway/src/chat/codex-model-catalog.js";

describe("Codex model catalog projection", () => {
  it("projects live app-server models and their effort/service-tier options", () => {
    const catalog = normalizeCodexModelCatalog({
      data: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Frontier coding model",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" },
        ],
        inputModalities: ["text", "image"],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Priority capacity" }],
        defaultServiceTier: "priority",
      }, {
        id: "hidden-model",
        model: "hidden-model",
        displayName: "Hidden",
        description: "Hidden",
        hidden: true,
        isDefault: false,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [],
      }],
      nextCursor: null,
    });

    expect(catalog).toMatchObject({
      defaultModel: "gpt-5.6-sol",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        capabilities: ["reasoning", "tools", "vision"],
        supportsVision: true,
      }],
      options: [{
        id: "effort",
        defaultValue: "low",
        values: [{ value: "low" }, { value: "high" }],
      }, {
        id: "service_tier",
        defaultValue: "priority",
        values: [{ value: "priority", label: "Fast" }],
      }],
    });
  });
});
