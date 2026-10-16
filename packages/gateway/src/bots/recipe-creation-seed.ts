import { BotCreationSeedResponseSchema, type BotCreationSeedResponse, type BotRecipeRef } from "@matrix-os/contracts";
import { BotRecipeCatalogError, type BotRecipeCatalog } from "./recipe-catalog.js";

/** A new editable custom definition; this never copies server policy or grants. */
export function editableBotRecipeSeed(catalog: Pick<BotRecipeCatalog,"resolve">, ref: BotRecipeRef): BotCreationSeedResponse {
  const recipe = catalog.resolve(ref);
  if (recipe.identitySource || recipe.recipeId === "personal-daily-brief" || recipe.recipeId === "jev-inbox-triage") {
    throw new BotRecipeCatalogError("recipe_unavailable");
  }
  return BotCreationSeedResponseSchema.parse({recipe:ref,editable:!recipe.integrations.some(integration=>integration.required),draft:{
    name:recipe.name,description:recipe.description,instructions:recipe.instructions,
    recipe:{skills:[],integrations:recipe.integrations.map(({service})=>({service})),output:recipe.output},
  }});
}
