import { z } from "zod/v4";
import { InstantiateBotRequestSchema } from "#bots/bot";
import type { GetStartedAnswers, GetStartedGoalId } from "#get-started";

// Spec 635, Section 7: "Make your AI yours". The owner's choices become one
// managed section of `system/soul.md`, rendered on the server from fixed
// sentences. SOUL shapes how the AI talks; it never grants tools,
// integrations or approvals (spec 551 R3).

export const GET_STARTED_SOUL_START = "<!-- matrix:get-started:start -->";
export const GET_STARTED_SOUL_END = "<!-- matrix:get-started:end -->";
export const GET_STARTED_BOT_NAME_MAX_CHARS = 24;
export const GET_STARTED_BOT_RULES_MAX_CHARS = 500;

export const GET_STARTED_PERSONALITIES = [
  { id: "friendly-helper", label: "Friendly helper", rule: "warm and encouraging; explain what you're doing as you go.", sample: "Happy to help! I'll walk you through it as I go." },
  { id: "straight-shooter", label: "Straight shooter", rule: "direct, no filler; say plainly when something is a bad idea.", sample: "Here's the fix. One warning: that change will lock the table." },
  { id: "calm-mentor", label: "Calm mentor", rule: "patient; teach as you go and check understanding.", sample: "Let's take it one step at a time. Does the first part make sense?" },
  { id: "playful-sidekick", label: "Playful sidekick", rule: "light and witty, and still get things done.", sample: "On it! That bug doesn't stand a chance." },
  { id: "professional-assistant", label: "Professional assistant", rule: "polished, structured and formal.", sample: "Certainly. Here is a short summary of the next steps." },
] as const;

const option = <const T extends string>(id: T, label: string, rule: string) => ({ id, label, rule });

export const GET_STARTED_BOT_STYLE = {
  length: { title: "Reply length", options: [option("short", "Short", "Keep replies short."), option("balanced", "Balanced", "Keep replies to a useful length."), option("detailed", "Detailed", "Give detailed replies when they help.")] },
  tone: { title: "Tone", options: [option("casual", "Casual", "Casual tone."), option("neutral", "Neutral", "Neutral tone."), option("formal", "Formal", "Formal tone.")] },
  humour: { title: "Humour", options: [option("none", "None", "No humour."), option("a-little", "A little", "A little humour."), option("plenty", "Plenty", "Plenty of humour.")] },
  emoji: { title: "Emoji", options: [option("never", "Never", "No emoji."), option("sometimes", "Sometimes", "Emoji now and then."), option("often", "Often", "Use emoji freely.")] },
  initiative: { title: "Initiative", options: [
    option("ask", "Only when I ask", "Only work on what {owner} asks for."),
    option("suggest", "Suggest next steps", "Suggest the next step when useful, but do not start work without asking."),
    option("daily", "Daily summary", "Offer a short daily summary, but never schedule anything without {owner}'s confirmation."),
  ] },
} as const;

export const GET_STARTED_BOT_LANGUAGES = [
  { id: "match", label: "Match my language" },
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "it", label: "Italiano" },
  { id: "pt", label: "Português" },
  { id: "mk", label: "Македонски" },
  { id: "zh", label: "中文" },
] as const;

type Ids<T extends readonly { id: string }[]> = T[number]["id"];
const ids = <T extends readonly { id: string }[]>(list: T) => list.map((item) => item.id) as [Ids<T>, ...Ids<T>[]];

/** No controls and no HTML comment markers, so free text can never break out of the managed section (the owner's name is held to the same rule in `#get-started`). */
const SafeText = (max: number) => z.string().trim().min(1).max(max)
  .regex(/^[^\p{Cc}]*$/u)
  .refine((value) => !value.includes("<!--") && !value.includes("-->"));

/** The bot's name also names the Matrix Bot, so it must pass bot creation's own label rule too. */
const BotName = SafeText(GET_STARTED_BOT_NAME_MAX_CHARS)
  .refine((value) => InstantiateBotRequestSchema.shape.name.safeParse(value).success);

export const GetStartedBotSchema = z.object({
  name: BotName,
  personality: z.enum(ids(GET_STARTED_PERSONALITIES)),
  length: z.enum(ids(GET_STARTED_BOT_STYLE.length.options)),
  tone: z.enum(ids(GET_STARTED_BOT_STYLE.tone.options)),
  humour: z.enum(ids(GET_STARTED_BOT_STYLE.humour.options)),
  emoji: z.enum(ids(GET_STARTED_BOT_STYLE.emoji.options)),
  language: z.enum(ids(GET_STARTED_BOT_LANGUAGES)),
  initiative: z.enum(ids(GET_STARTED_BOT_STYLE.initiative.options)),
  rules: SafeText(GET_STARTED_BOT_RULES_MAX_CHARS).optional(),
}).strict();
export type GetStartedBot = z.infer<typeof GetStartedBotSchema>;
export type GetStartedBotStyleField = keyof typeof GET_STARTED_BOT_STYLE;

export const DEFAULT_GET_STARTED_BOT: GetStartedBot = {
  name: "Matrix",
  personality: "friendly-helper",
  length: "balanced",
  tone: "neutral",
  humour: "a-little",
  emoji: "sometimes",
  language: "match",
  initiative: "suggest",
};

const GOAL_PHRASES: Record<GetStartedGoalId, string> = {
  code: "write code with agents",
  business: "run their business",
  assistant: "have a personal assistant",
  build: "build apps",
  explore: "explore",
};

function rule(field: GetStartedBotStyleField, value: string): string {
  return GET_STARTED_BOT_STYLE[field].options.find((candidate) => candidate.id === value)?.rule ?? "";
}

function joinPhrases(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The managed SOUL section for these answers, markers included. Only fixed sentences and validated text. */
export function renderGetStartedSoulSection(answers: GetStartedAnswers & { bot: GetStartedBot }): string {
  const bot = answers.bot;
  const owner = answers.name ?? "the owner";
  const possessive = answers.name ? `${answers.name}'s` : "the owner's";
  const personality = GET_STARTED_PERSONALITIES.find((candidate) => candidate.id === bot.personality) ?? GET_STARTED_PERSONALITIES[0];
  const language = bot.language === "match"
    ? `Reply in the language ${owner} writes in.`
    : `Reply in ${GET_STARTED_BOT_LANGUAGES.find((candidate) => candidate.id === bot.language)?.label ?? "English"}.`;
  const goals = answers.goals.map((goal) => GOAL_PHRASES[goal]);
  const working = [
    `- ${rule("initiative", bot.initiative).replaceAll("{owner}", owner)}`,
    "- Always ask before doing anything outside Matrix.",
    ...(goals.length > 0 ? [`- ${answers.name ?? "The owner"} mostly uses Matrix to ${joinPhrases(goals)}.`] : []),
    ...(bot.rules ? [`- Always follow this: ${bot.rules}`] : []),
  ];
  return [
    GET_STARTED_SOUL_START,
    "## Who you are",
    `Your name is ${bot.name}. You are ${possessive} personal Matrix assistant.`,
    "",
    "## Personality",
    `${personality.label}: ${personality.rule}`,
    "",
    "## Style",
    `- ${rule("length", bot.length)}`,
    `- ${[rule("tone", bot.tone), rule("humour", bot.humour), rule("emoji", bot.emoji)].join(" ")}`,
    `- ${language}`,
    "",
    `## Working with ${owner}`,
    ...working,
    GET_STARTED_SOUL_END,
  ].join("\n");
}

/**
 * Replaces only the managed section, or puts it first; everything the owner wrote elsewhere stays.
 * First, because the kernel reads only the start of SOUL (`MAX_SOUL_CHARS`), while bots read all of it.
 */
export function replaceGetStartedSoulSection(soul: string, section: string): string {
  const start = soul.indexOf(GET_STARTED_SOUL_START);
  const end = start === -1 ? -1 : soul.indexOf(GET_STARTED_SOUL_END, start);
  if (start !== -1 && end !== -1) return `${soul.slice(0, start)}${section}${soul.slice(end + GET_STARTED_SOUL_END.length)}`;
  const rest = soul.trim();
  return rest ? `${section}\n\n${rest}\n` : `${section}\n`;
}

/** The kernel's SOUL read limit (packages/kernel/src/soul.ts); the managed section must fit inside it. */
export const KERNEL_SOUL_READ_MAX_CHARS = 2000;

/** A one-line sample reply that follows the chosen personality and style, for the live preview. */
export function getStartedBotPreview(bot: GetStartedBot): string {
  const personality = GET_STARTED_PERSONALITIES.find((candidate) => candidate.id === bot.personality) ?? GET_STARTED_PERSONALITIES[0];
  let sample: string = personality.sample;
  if (bot.length === "short") sample = sample.split(/(?<=[.!?])\s/)[0] ?? sample;
  if (bot.length === "detailed") sample = `${sample} I'll note anything you should double-check.`;
  if (bot.emoji === "often") sample = `${sample} 🙌`;
  if (bot.emoji === "never") sample = sample.replace(/\p{Extended_Pictographic}/gu, "").trim();
  return sample;
}
