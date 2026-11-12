import { z } from "zod/v4";
import { GET_STARTED_GOALS, type GetStartedGoalId } from "#get-started";
import { GET_STARTED_BOT_NAME_MAX_CHARS, GET_STARTED_PERSONALITIES, GetStartedBotSchema } from "#get-started-bot";

// Spec 636, Part B: five suggested names for the main bot, each with one emoji.
// A small model on the platform suggests them; the built-in list below stands
// in whenever it cannot, so the step never shows an error.

export const GET_STARTED_BOT_NAME_SUGGESTION_COUNT = 5;
/** Names already shown that a refresh may ask the model to avoid. */
export const GET_STARTED_BOT_NAME_EXCLUDE_MAX = 30;

/** Letters, spaces, apostrophes and hyphens only: the only free text that ever reaches the prompt. */
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}' -]*$/u;
const EMOJI_PATTERN = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️)+$/u;
const EMOJI_MAX_CODE_UNITS = 16;

function isSingleGrapheme(value: string): boolean {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1;
}

const SuggestedName = z.string().trim().min(1).max(GET_STARTED_BOT_NAME_MAX_CHARS)
  .regex(NAME_PATTERN)
  // The name becomes the Matrix Bot's name, so it must pass that rule too.
  .refine((value) => GetStartedBotSchema.shape.name.safeParse(value).success);

const Emoji = z.string().max(EMOJI_MAX_CODE_UNITS)
  .regex(EMOJI_PATTERN)
  .refine((value) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value) && isSingleGrapheme(value));

export const GetStartedBotNameSuggestionSchema = z.object({ name: SuggestedName, emoji: Emoji }).strict();
export type GetStartedBotNameSuggestion = z.infer<typeof GetStartedBotNameSuggestionSchema>;

const goalIds = GET_STARTED_GOALS.map((goal) => goal.id) as [GetStartedGoalId, ...GetStartedGoalId[]];
const personalityIds = GET_STARTED_PERSONALITIES.map((personality) => personality.id) as [
  (typeof GET_STARTED_PERSONALITIES)[number]["id"],
  ...(typeof GET_STARTED_PERSONALITIES)[number]["id"][],
];

export const GetStartedBotNamesRequestSchema = z.object({
  goals: z.array(z.enum(goalIds)).max(goalIds.length),
  personality: z.enum(personalityIds),
  exclude: z.array(SuggestedName).max(GET_STARTED_BOT_NAME_EXCLUDE_MAX).default([]),
}).strict();
export type GetStartedBotNamesRequest = z.input<typeof GetStartedBotNamesRequestSchema>;

export const GetStartedBotNamesResponseSchema = z.object({
  names: z.array(GetStartedBotNameSuggestionSchema).length(GET_STARTED_BOT_NAME_SUGGESTION_COUNT)
    .refine((names) => new Set(names.map((item) => item.name.toLowerCase())).size === names.length),
}).strict();
export type GetStartedBotNamesResponse = z.infer<typeof GetStartedBotNamesResponseSchema>;

/** Shown when suggestions are unavailable; refresh pages through all of it before any name repeats. */
export const GET_STARTED_FALLBACK_BOT_NAMES: readonly GetStartedBotNameSuggestion[] = [
  { name: "Atlas", emoji: "🧭" }, { name: "Nova", emoji: "✨" }, { name: "Ada", emoji: "💡" }, { name: "Sage", emoji: "🦉" }, { name: "Mira", emoji: "🌟" },
  { name: "Ember", emoji: "🔥" }, { name: "Willow", emoji: "🌿" }, { name: "Pepper", emoji: "🌶️" }, { name: "Iris", emoji: "🌸" }, { name: "Otto", emoji: "🤖" },
  { name: "Clover", emoji: "🍀" }, { name: "Mango", emoji: "🥭" }, { name: "Indigo", emoji: "🎨" }, { name: "Robin", emoji: "🐦" }, { name: "Jasper", emoji: "💎" },
  { name: "Hazel", emoji: "🌰" }, { name: "Milo", emoji: "🐶" }, { name: "Coral", emoji: "🪸" }, { name: "Basil", emoji: "🌱" }, { name: "Remy", emoji: "🐭" },
  { name: "Skye", emoji: "☁️" }, { name: "Ziggy", emoji: "⚡" }, { name: "Olive", emoji: "🫒" }, { name: "Rocket", emoji: "🚀" }, { name: "Penny", emoji: "🪙" },
  { name: "Harbor", emoji: "⚓" }, { name: "Lumen", emoji: "🔆" }, { name: "Peach", emoji: "🍑" }, { name: "Bolt", emoji: "🔩" }, { name: "Poppy", emoji: "🌺" },
  { name: "Rio", emoji: "🌊" }, { name: "Tango", emoji: "💃" }, { name: "Waffles", emoji: "🧇" }, { name: "Biscuit", emoji: "🍪" }, { name: "Nimbus", emoji: "🌥️" },
  { name: "Scout", emoji: "🔭" }, { name: "Felix", emoji: "🐱" }, { name: "Cosmo", emoji: "🌌" }, { name: "Saffron", emoji: "🌼" }, { name: "Bramble", emoji: "🫐" },
];

/** Page `page` of the built-in names, five at a time, starting over past the end. */
export function getStartedFallbackBotNames(page: number): GetStartedBotNameSuggestion[] {
  const total = GET_STARTED_FALLBACK_BOT_NAMES.length;
  const start = (Math.max(0, Math.trunc(page)) * GET_STARTED_BOT_NAME_SUGGESTION_COUNT) % total;
  return Array.from({ length: GET_STARTED_BOT_NAME_SUGGESTION_COUNT }, (_, index) => GET_STARTED_FALLBACK_BOT_NAMES[(start + index) % total]!);
}
