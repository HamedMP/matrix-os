import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { BotRecipeSummary, ChatAgent } from "@matrix-os/contracts";
import { BotClientError, type BotClient } from "../chat-agents/bots/client.js";
import type { ChatAgentClient } from "../chat-agents/client.js";

export const COMPANY_BRAIN_RECIPE_ID = "company-brain";

/** Where the Company Brain Bot of this owner stands. Only `ready` has a Bot that can answer. */
export type CompanyBrainBotState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "setup" }
  | { readonly kind: "archived" }
  | { readonly kind: "ready"; readonly botId: string };

const UNAVAILABLE: CompanyBrainBotState = { kind: "unavailable" };
const ARCHIVED: CompanyBrainBotState = { kind: "archived" };

/** Bots answer 503 when they are off here or have no runtime host: chat with the brain is not running. */
export function botsNotRunning(error: unknown): boolean {
  return error instanceof BotClientError && error.status === 503;
}

/** The oldest active Company Brain Bot. The library lists active Bots only; an archived one is never in it. */
function activeBrainBot(agents: readonly ChatAgent[], id?: string): ChatAgent | undefined {
  return agents.filter((agent) => !agent.archived && agent.recipeRef?.recipeId === COMPANY_BRAIN_RECIPE_ID
    && (id === undefined || agent.id === id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
}

/** The recipe is kept out of the Templates list, so it is asked for by id. */
async function brainRecipe(bots: BotClient): Promise<BotRecipeSummary | undefined> {
  return (await bots.recipes(COMPANY_BRAIN_RECIPE_ID)).find((recipe) => recipe.recipeId === COMPANY_BRAIN_RECIPE_ID);
}

/** Bots that are off here read as unavailable; any other failure is the caller's to show. */
async function unlessNotRunning(read: () => Promise<CompanyBrainBotState>): Promise<CompanyBrainBotState> {
  try {
    return await read();
  } catch (error: unknown) {
    if (botsNotRunning(error)) return UNAVAILABLE;
    throw error;
  }
}

/**
 * Reads the owner's Bots once. An active Company Brain Bot is ready. Without one, the one-time setup card shows only
 * where Bots run and serve the recipe; Bots that are off read as unavailable.
 */
export async function findCompanyBrainBot(client: ChatAgentClient): Promise<CompanyBrainBotState> {
  const bots = client.bots;
  if (!bots) return UNAVAILABLE;
  return unlessNotRunning(async () => {
    const library = await client.list();
    if (!library.enabled) return UNAVAILABLE;
    const active = activeBrainBot(library.agents);
    if (active) return { kind: "ready", botId: active.id };
    return await brainRecipe(bots) ? { kind: "setup" } : UNAVAILABLE;
  });
}

/** Start makes at most this many requests in a row when each one replays a Bot the owner archived since. */
const START_ATTEMPTS = 5;

/**
 * Creates the Company Brain Bot, then reads the library again. No model is sent: the server picks Automatic, and a
 * replay never changes the Bot's model. The request id is fixed per recipe version, so a double click or a retry makes
 * one Bot. A replay can return a Bot that was archived since, which the library no longer lists: Start then asks again
 * with a request id made from that Bot, so the owner gets a new Bot, still one however often Start is pressed.
 */
export async function createCompanyBrainBot(client: ChatAgentClient): Promise<CompanyBrainBotState> {
  const bots = client.bots;
  if (!bots) return UNAVAILABLE;
  return unlessNotRunning(async () => {
    const recipe = await brainRecipe(bots);
    if (!recipe) return UNAVAILABLE;
    const base = `${recipe.recipeId}@${recipe.version}`;
    let seed = base;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      const result = await bots.instantiate({
        recipe: { recipeId: recipe.recipeId, version: recipe.version },
        clientRequestId: `req_companybrain_${bytesToHex(sha256(utf8ToBytes(seed)))}`,
      });
      const state = await listedState(client, result.agent.id);
      if (state.kind !== "archived" || result.operation !== "replayed") return state;
      seed = `${base}:after:${result.agent.id}`;
    }
    return ARCHIVED;
  });
}

/** Reads the library after Start: the Bot Start returned is ready only while it is listed as active. */
async function listedState(client: ChatAgentClient, botId: string): Promise<CompanyBrainBotState> {
  const library = await client.list();
  if (!library.enabled) return UNAVAILABLE;
  const made = activeBrainBot(library.agents, botId);
  return made ? { kind: "ready", botId: made.id } : ARCHIVED;
}
