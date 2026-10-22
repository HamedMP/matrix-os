import type { BotInstantiation } from "../bots/instantiation.js";
import type { BotRecipeCatalog } from "../bots/recipe-catalog.js";

/** One fixed request id per owner: retries and repeat completions replay the same bot instead of adding one. */
export const GET_STARTED_MATRIX_BOT_REQUEST_ID = "req_get-started-matrix-bot";
const MATRIX_BOT_RECIPE_ID = "matrix-bot";

/**
 * Spec 635, Section 7: the personal Matrix Bot, named by the owner. Its recipe reads the
 * owner SOUL, so the personality the wizard wrote applies on its next turn.
 */
export function createGetStartedMatrixBot(services: { recipes: Pick<BotRecipeCatalog, "list">; instantiation: Pick<BotInstantiation, "instantiate"> }) {
  return async (ownerId: string, name: string): Promise<void> => {
    const recipe = services.recipes.list().find((candidate) => candidate.recipeId === MATRIX_BOT_RECIPE_ID);
    if (!recipe) throw new Error("MatrixBotRecipeUnavailable");
    await services.instantiation.instantiate(ownerId, {
      clientRequestId: GET_STARTED_MATRIX_BOT_REQUEST_ID,
      recipe: { recipeId: recipe.recipeId, version: recipe.version },
      name,
    });
  };
}
