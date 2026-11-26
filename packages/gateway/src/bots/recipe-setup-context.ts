import { BotRecipeSetupContextSchema, type BotRecipeRef } from "@matrix-os/contracts";
import { createBotRecipeCatalog, type BotRecipeCatalog } from "./recipe-catalog.js";

const launchCatalog = createBotRecipeCatalog();

/** Only advertised versions can seed setup. Retained and internal execution recipes stay private. */
export function recipeSetupContext(ref: BotRecipeRef, catalog: Pick<BotRecipeCatalog, "list"> = launchCatalog) {
  const recipe = catalog.list().find(item => item.recipeId === ref.recipeId && item.version === ref.version);
  if (!recipe) return null;
  const { recipeId, version, name, description, instructions, output, capabilities, integrations } = recipe;
  // Native recipes declare broker tools and service requirements, but no pinned Skill or MCP server IDs.
  return BotRecipeSetupContextSchema.parse({
    recipeId, version, name, description, instructions, output, capabilities, integrations, skills: [], mcpServers: [],
  });
}
