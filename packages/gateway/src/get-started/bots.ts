import { InstantiateBotRequestSchema, type GetStartedSavedBot } from "@matrix-os/contracts";
import { instantiationPayloadHash, type BotInstantiation } from "../bots/instantiation.js";
import type { BotRecipeCatalog } from "../bots/recipe-catalog.js";

/** One fixed request id per owner and recipe: retries and repeat completions replay the same bot. */
export function getStartedBotRequestId(recipeId: string): string {
  return `req_get-started-${recipeId}`;
}

/** The request that continues an attempt whose request can no longer be replayed; bot IDs are unique, so it needs no recipe. */
export function getStartedBotFollowUpRequestId(previousBotId: string): string {
  return `req_get-started-after-${previousBotId}`;
}

export const GET_STARTED_MATRIX_BOT_RECIPE_ID = "matrix-bot";
export const GET_STARTED_MATRIX_BOT_REQUEST_ID = getStartedBotRequestId(GET_STARTED_MATRIX_BOT_RECIPE_ID);

/** Bounds the attempts for one saved bot, so a broken recipe can't be retried forever. */
export const MAX_GET_STARTED_BOT_ATTEMPTS = 4;

type GetStartedBotServices = {
  recipes: Pick<BotRecipeCatalog, "list">;
  instantiation: Pick<BotInstantiation, "instantiate" | "attempt" | "finishFromDefinition">;
};

type Attempt = NonNullable<Awaited<ReturnType<BotInstantiation["attempt"]>>> & { clientRequestId: string };

/**
 * The creation requests Get started made for one saved bot, oldest first. Each follow-up is named
 * after the bot its predecessor reserved, so they are found again without storing anything.
 */
async function attemptsFor(instantiation: Pick<BotInstantiation, "attempt">, ownerId: string, recipeId: string): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let clientRequestId = getStartedBotRequestId(recipeId);
  while (attempts.length < MAX_GET_STARTED_BOT_ATTEMPTS) {
    const attempt = await instantiation.attempt(ownerId, clientRequestId);
    if (!attempt) break;
    attempts.push({ ...attempt, clientRequestId });
    if (attempt.active) break;
    clientRequestId = getStartedBotFollowUpRequestId(attempt.botId);
  }
  return attempts;
}

/**
 * Spec 635, Sections 7 and 7b: creates the owner's personal Matrix Bot (named by them; its
 * recipe reads the owner SOUL) and any ready-made bots they added, through the existing
 * instantiation service. Creating a bot grants it no app access. A retry replays the same
 * request; one made under an older recipe version is finished from its saved definition, or,
 * when it never wrote one, started again under a follow-up request.
 */
export function createGetStartedBots(services: GetStartedBotServices) {
  return async (ownerId: string, recipeId: string, name?: string): Promise<void> => {
    const recipe = services.recipes.list().find((candidate) => candidate.recipeId === recipeId);
    if (!recipe) throw new Error("BotRecipeUnavailable");
    const attempts = await attemptsFor(services.instantiation, ownerId, recipe.recipeId);
    if (attempts.some((attempt) => attempt.active)) return;
    const request = (clientRequestId: string) => ({
      clientRequestId,
      recipe: { recipeId: recipe.recipeId, version: recipe.version },
      ...(name ? { name } : {}),
    });
    const last = attempts.at(-1);
    if (!last) {
      await services.instantiation.instantiate(ownerId, request(getStartedBotRequestId(recipe.recipeId)));
      return;
    }
    // Hashed as the instantiation service hashes the parsed request, so a replay matches exactly.
    if (last.payloadHash === instantiationPayloadHash(InstantiateBotRequestSchema.parse(request(last.clientRequestId)))) {
      await services.instantiation.instantiate(ownerId, request(last.clientRequestId));
      return;
    }
    if (await services.instantiation.finishFromDefinition(ownerId, last.clientRequestId)) return;
    if (attempts.length >= MAX_GET_STARTED_BOT_ATTEMPTS) throw new Error("BotRetriesExhausted");
    await services.instantiation.instantiate(ownerId, request(getStartedBotFollowUpRequestId(last.botId)));
  };
}

/**
 * Spec 635: what a saved bot choice made. "created" names the bot Get started created (the bot list
 * leaves removed bots out, so this tells a removed bot from one never made); "pending" means its
 * creation never finished, which Getting started offers to create again.
 */
export function createGetStartedBotStatus(services: { instantiation: Pick<BotInstantiation, "attempt"> }) {
  return async (ownerId: string, recipeId: string): Promise<GetStartedSavedBot> => {
    const created = (await attemptsFor(services.instantiation, ownerId, recipeId)).find((attempt) => attempt.active);
    return created ? { status: "created", agentId: created.botId } : { status: "pending" };
  };
}
