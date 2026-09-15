import { describe, expect, it } from "vitest";
import { resolveRecipeHandoff, buildAgentRecipePrompt } from "../../packages/ui/src/chat-agents/recipe-handoff.js";
import { agentInspirations } from "../../packages/ui/src/chat-agents/agent-inspirations.generated.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { matrixRecipes, matrixRecipeCatalogContract } from "../../packages/ui/src/chat-agents/matrix-recipes.generated.js";
import { recipes as siteRecipesV1 } from "../contracts/fixtures/matrix-recipes.v1.js";

describe("public recipe handoff", () => {
  it("preserves the complete version 1 website contract and its exact prompt handoff", async () => {
    const bytes = await readFile(new URL("../contracts/fixtures/matrix-recipes.v1.ts", import.meta.url));
    expect(matrixRecipeCatalogContract).toEqual({
      version: 1,
      sourceRepository: "FinnaAI/matrix-os-site",
      sourceCommit: "1185ec8efe84ce93a6650369ec7cb3fcfc9e72bd",
      sourcePath: "src/components/landing/recipes.ts",
      sourceSha256: "1562618a2a7e5c7a25063539dcbd15eb7fb44f16a0dae90625e90a1426d72993",
    });
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(matrixRecipeCatalogContract.sourceSha256);
    expect(matrixRecipes).toEqual(siteRecipesV1);
    for (const recipe of siteRecipesV1) {
      expect(resolveRecipeHandoff(recipe.id)).toEqual({ id: recipe.id, prompt: recipe.prompt });
      expect(agentInspirations.some((inspiration) => inspiration.id === recipe.id)).toBe(false);
    }
  });
  it("resolves every public inspiration to the same prompt as the in-app library", () => {
    for (const recipe of agentInspirations) {
      expect(resolveRecipeHandoff(recipe.id)?.prompt).toBe(buildAgentRecipePrompt(recipe));
    }
  });
  it.each(["market-research", "weekly-report", "bug-fix", "campaign-brief", "meeting-follow-up", "spend-review"])("resolves the owned task %s", (id) => {
    expect(resolveRecipeHandoff(id)?.prompt).toMatch(/Ask for approval/);
  });
  it.each([null, "", "unknown-recipe", "../account-book", "x".repeat(201), "account-book&prompt=run"])("rejects an unrecognized identifier %s", (id) => {
    expect(resolveRecipeHandoff(id)).toBeNull();
  });
});
