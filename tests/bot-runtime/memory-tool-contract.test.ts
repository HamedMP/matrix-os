import { describe, expect, it } from "vitest";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
import { buildBotSystemPrompt } from "../../packages/gateway/src/bots/system-prompt.js";
import { createBotRecipeCatalog } from "../../packages/gateway/src/bots/recipe-catalog.js";

describe("Pi memory instructions", () => {
  it("tells the model how to save an owner-stated preference without inventing provenance", () => {
    const remember = createBotTools({ capabilities: ["memory.propose"], broker: {} as never,
      state: { waitingForPerson: false, effectUnknown: false } }).find((tool) => tool.name === "remember");
    expect(remember).toBeDefined();
    expect(Object.keys(remember!.parameters.properties)).toEqual(["kind", "content"]);
    expect(remember!.description).toMatch(/owner-stated/i);
    expect(remember!.description).not.toMatch(/sourceUrl|source URL/i);

    const recipe = createBotRecipeCatalog().resolve({ recipeId: "writing-bot", version: "2026-09-27.1" });
    const prompt = buildBotSystemPrompt({ botName: recipe.name, instructions: recipe.instructions, recipe,
      now: new Date("2026-09-29T00:00:00Z") });
    expect(prompt).toMatch(/pending confirmation.*not.*remembered/i);
    expect(prompt).not.toMatch(/sourceUrl|source URL/i);
  });
});
