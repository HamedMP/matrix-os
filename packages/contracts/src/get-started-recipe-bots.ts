import type { GetStartedGoalId } from "#get-started";

// Spec 635, Section 7b: "Bots for you". Ready-made bots from the Matrix Bot
// recipe catalog, suggested by goal on the wizard's last screen. Adding one
// only creates it; it gets no app access until the owner grants it.

export const GET_STARTED_RECIPE_BOTS = [
  { recipeId: "personal-daily-brief", label: "Daily Brief", why: "A short brief of your day from your calendar and inbox", needs: ["google_calendar", "gmail"] },
  { recipeId: "jev-inbox-triage", label: "Jev Inbox Triage", why: "Sorts and labels your Gmail inbox once you grant access", needs: ["gmail"] },
  { recipeId: "event-request-desk", label: "Event Request Desk", why: "Scores event and speaking requests and drafts your replies", needs: [] },
  { recipeId: "account-book", label: "Account Research Desk", why: "Writes a sourced brief before your sales calls", needs: [] },
  { recipeId: "competitor-watching", label: "Competitor Watch", why: "Tells you what actually changed on competitor pages", needs: [] },
  { recipeId: "writing-bot", label: "Writing Bot", why: "Helps you draft and revise in your own voice", needs: [] },
  { recipeId: "echo", label: "Meeting Recap Deck", why: "Turns your meeting notes into a recap deck", needs: [] },
] as const;

export type GetStartedRecipeBotId = (typeof GET_STARTED_RECIPE_BOTS)[number]["recipeId"];
export type GetStartedRecipeBot = (typeof GET_STARTED_RECIPE_BOTS)[number];

export const GET_STARTED_RECIPE_BOT_IDS = GET_STARTED_RECIPE_BOTS.map((bot) => bot.recipeId) as [GetStartedRecipeBotId, ...GetStartedRecipeBotId[]];
export const GET_STARTED_RECIPE_BOTS_MAX = 3;

const BY_GOAL: Record<GetStartedGoalId, readonly GetStartedRecipeBotId[]> = {
  business: ["personal-daily-brief", "jev-inbox-triage", "event-request-desk"],
  assistant: ["personal-daily-brief", "writing-bot", "echo"],
  code: ["writing-bot"],
  build: ["writing-bot"],
  explore: ["writing-bot", "personal-daily-brief"],
};

export interface GetStartedRecipeBotSuggestion {
  bot: GetStartedRecipeBot;
  /** Required apps that are not connected yet; the bot can be added once they are. */
  missing: string[];
}

/** Bot ids worth suggesting for these goals, in goal order, capped. Connections do not change the list. */
export function getStartedRecipeBotIdsForGoals(goals: readonly GetStartedGoalId[]): GetStartedRecipeBotId[] {
  const ids = new Set<GetStartedRecipeBotId>();
  for (const goal of goals.length > 0 ? goals : (["explore"] as const)) for (const id of BY_GOAL[goal]) ids.add(id);
  return [...ids].slice(0, GET_STARTED_RECIPE_BOTS_MAX);
}

export function getStartedRecipeBotSuggestions(goals: readonly GetStartedGoalId[], connected: ReadonlySet<string>): GetStartedRecipeBotSuggestion[] {
  return getStartedRecipeBotIdsForGoals(goals).flatMap((id) => {
    const bot = GET_STARTED_RECIPE_BOTS.find((candidate) => candidate.recipeId === id);
    return bot ? [{ bot, missing: bot.needs.filter((service) => !connected.has(service)) }] : [];
  });
}
