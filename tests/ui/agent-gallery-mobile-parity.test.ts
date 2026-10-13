import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES,
  buildAgentGallery,
  GALLERY_CATEGORIES,
  inspirationSetupPrompt,
  LAUNCH_RECIPE_IDS,
} from "../../apps/mobile/components/agents/agent-gallery";
import { agentInspirations as mobileInspirations } from "../../apps/mobile/components/agents/agent-inspirations.generated";
import { agentInspirations } from "../../packages/ui/src/chat-agents/agent-inspirations.generated.js";
import { BOT_RECIPE_COUNT } from "../../packages/ui/src/chat-agents/AgentRecipesPanel.js";
import {
  buildAgentRecipePrompt,
  isLaunchBotRecipeId,
  LAUNCH_BOT_RECIPE_IDS,
} from "../../packages/ui/src/chat-agents/recipe-handoff.js";

// The label the web's panel filters out wherever it shows a category.
const SOURCE_COLLECTION = "From Grok Bot Team";

describe("the template gallery on Web and Native Mobile", () => {
  it("ships Native Mobile the web's inspirations, without the marketplace's own collection", () => {
    expect(mobileInspirations).toEqual(agentInspirations.map((inspiration) => ({
      id: inspiration.id,
      name: inspiration.name,
      categories: inspiration.categories.filter((category) => category !== SOURCE_COLLECTION),
      description: inspiration.description,
      skills: inspiration.skills,
      integrations: inspiration.integrations,
    })));
  });

  it("offers the same categories in the same order", () => {
    // The web panel's own expression.
    const web = ["All", ...new Set(agentInspirations.flatMap((recipe) => (
      recipe.categories.filter((value) => value !== SOURCE_COLLECTION)
    )))].slice(0, 8);

    expect(GALLERY_CATEGORIES).toEqual(web);
  });

  it("keeps the same launch templates for the computer", () => {
    expect(LAUNCH_RECIPE_IDS).toEqual([...LAUNCH_BOT_RECIPE_IDS]);
  });

  it("lists the same inspirations as the web's bot mode, so both show as many templates", () => {
    const { inspirations } = buildAgentGallery([], { query: "", category: ALL_CATEGORIES });

    expect(inspirations.map((inspiration) => inspiration.id)).toEqual(
      agentInspirations.filter((recipe) => !isLaunchBotRecipeId(recipe.id)).map((recipe) => recipe.id),
    );
    expect(inspirations.length + LAUNCH_BOT_RECIPE_IDS.length).toBe(BOT_RECIPE_COUNT);
  });

  it.each(["Sales", "Marketing", "Operations", "Personal", "Product", "Design", "Engineering"])(
    "narrows to the same inspirations under %s",
    (category) => {
      const { inspirations } = buildAgentGallery([], { query: "", category });

      expect(inspirations.map((inspiration) => inspiration.id)).toEqual(
        agentInspirations
          .filter((recipe) => recipe.categories.includes(category) && !isLaunchBotRecipeId(recipe.id))
          .map((recipe) => recipe.id),
      );
    },
  );

  it.each(["gmail", "Follow-Up", "budget", "notion", "ENGINEER"])("finds the same inspirations for %s", (query) => {
    const wanted = query.toLocaleLowerCase();
    const { inspirations } = buildAgentGallery([], { query, category: ALL_CATEGORIES });

    // The web panel's own fields.
    expect(inspirations.map((inspiration) => inspiration.id)).toEqual(
      agentInspirations
        .filter((recipe) => !isLaunchBotRecipeId(recipe.id)
          && [recipe.name, recipe.description, ...recipe.categories, ...recipe.skills, ...recipe.integrations]
            .some((value) => value.toLocaleLowerCase().includes(wanted)))
        .map((recipe) => recipe.id),
    );
  });

  it("builds every inspiration in chat from the same prompt", () => {
    for (const [index, recipe] of agentInspirations.entries()) {
      expect(inspirationSetupPrompt(mobileInspirations[index]!)).toBe(buildAgentRecipePrompt(recipe));
    }
  });
});
