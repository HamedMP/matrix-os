import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../client.js";

export const DAILY_BRIEF_RECIPE_ID = "personal-daily-brief";
const LEGACY_DAILY_BRIEF_INSTRUCTIONS = "Prepare today's daily brief from connected email and calendar sources.";

/** Compatibility entry for the former built-in skill recipe, not Bot identity or a migration.
 * Names, instructions, output, accounts and historical Chats remain owner-controlled.
 * Specialists with edited instructions or additional skills retain custom execution behavior.
 */
export function isLegacyDailyBriefEntry(agent: ChatAgent): boolean {
  return !agent.recipeRef && agent.instructions === LEGACY_DAILY_BRIEF_INSTRUCTIONS
    && agent.recipe?.skills.length === 2
    && agent.recipe.skills.includes("matrix-personal-daily-brief")
    && agent.recipe.skills.includes("matrix-integrations");
}

/** Reuse an authenticated recipe binding; create only when no canonical recipe Bot exists.
 * The stable owner-scoped operation key makes concurrent entry/retry idempotent.
 * Omit editable fields/selection so replay never overwrites existing settings.
 */
export async function resolveDailyBriefChat(client: ChatAgentClient, current = () => true): Promise<string | null> {
  if (!client.bots) throw new Error("Bots unavailable");
  const library = await client.list();
  if (!current()) return null;
  if (!library.enabled) throw new Error("Bots unavailable");
  const existing = library.agents.filter(agent => !agent.archived && agent.recipeRef?.recipeId === DAILY_BRIEF_RECIPE_ID)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (existing) {
    const chatId = await client.bots.directChat(existing.id);
    if (!current()) return null;
    if (!chatId) throw new Error("Missing bot binding");
    return chatId;
  }
  const recipes = await client.bots.recipes();
  if (!current()) return null;
  const recipe = recipes.find(candidate => candidate.recipeId === DAILY_BRIEF_RECIPE_ID);
  if (!recipe) throw new Error("Recipe unavailable");
  const key = bytesToHex(sha256(utf8ToBytes(`${recipe.recipeId}@${recipe.version}`)));
  const result = await client.bots.instantiate({ recipe: { recipeId: recipe.recipeId, version: recipe.version }, clientRequestId: `req_dailybrief_${key}` });
  if (!current()) return null;
  // Instantiation replay can return an archived definition. Re-read active
  // owner state rather than treating its coarse operation status as lifecycle.
  const verified = await client.list();
  if (!current()) return null;
  const active = verified.enabled && verified.agents.find(agent => agent.id === result.agent.id
    && !agent.archived && agent.recipeRef?.recipeId === DAILY_BRIEF_RECIPE_ID);
  if (!active) throw new Error("Daily Brief is not active");
  const chatId = await client.bots.directChat(active.id);
  if (!current()) return null;
  if (!chatId || chatId !== result.chatId) throw new Error("Missing bot binding");
  return chatId;
}
