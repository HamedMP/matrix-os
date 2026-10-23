import type { BotInstantiation } from "../bots/instantiation.js";
import type { BotRecipeCatalog } from "../bots/recipe-catalog.js";

/** One fixed request id per owner and recipe: retries and repeat completions replay the same bot. */
export function getStartedBotRequestId(recipeId: string): string {
  return `req_get-started-${recipeId}`;
}

export const GET_STARTED_MATRIX_BOT_RECIPE_ID = "matrix-bot";
export const GET_STARTED_MATRIX_BOT_REQUEST_ID = getStartedBotRequestId(GET_STARTED_MATRIX_BOT_RECIPE_ID);

/**
 * Spec 635, Sections 7 and 7b: creates the owner's personal Matrix Bot (named by them; its
 * recipe reads the owner SOUL) and any ready-made bots they added, through the existing
 * instantiation service. Creating a bot grants it no app access.
 */
export function createGetStartedBots(services: { recipes: Pick<BotRecipeCatalog, "list">; instantiation: Pick<BotInstantiation, "instantiate" | "completed"> }) {
  return async (ownerId: string, recipeId: string, name?: string): Promise<void> => {
    const recipe = services.recipes.list().find((candidate) => candidate.recipeId === recipeId);
    if (!recipe) throw new Error("BotRecipeUnavailable");
    await services.instantiation.instantiate(ownerId, {
      clientRequestId: getStartedBotRequestId(recipe.recipeId),
      recipe: { recipeId: recipe.recipeId, version: recipe.version },
      ...(name ? { name } : {}),
    });
  };
}

/**
 * Spec 635: whether a saved bot was ever created, from its fixed-request operation. The bot list
 * leaves removed bots out, so this is what tells a removed bot ("created") from one whose
 * creation never finished ("pending", which Getting started offers to create again).
 */
export function createGetStartedBotStatus(services: { instantiation: Pick<BotInstantiation, "completed"> }) {
  return async (ownerId: string, recipeId: string): Promise<"created" | "pending"> =>
    (await services.instantiation.completed(ownerId, getStartedBotRequestId(recipeId))) ? "created" : "pending";
}
