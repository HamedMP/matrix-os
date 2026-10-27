import { z } from "zod/v4";
import { ChatAgentIdSchema } from "#chat-agent-context";
import { GetStartedBotSchema } from "#get-started-bot";
import { GET_STARTED_RECIPE_BOT_IDS, GET_STARTED_RECIPE_BOTS_MAX } from "#get-started-recipe-bots";

// Spec 635: the Get started wizard. Answers are stable IDs from this catalog,
// never display strings, so the gateway can validate them and later layers
// (ordering, connect, SOUL) can map them without parsing free text.

export const GET_STARTED_NAME_MAX_CHARS = 40;
export const GET_STARTED_DRAFT_MAX_BYTES = 4 * 1024;
/** Name, goals, coding agents, tools, the main bot's name and style, App Gallery, bots, and the summary: the last step index is this minus one. */
export const GET_STARTED_STEP_COUNT = 8;

export const GET_STARTED_GOALS = [
  { id: "code", label: "Write code with agents" },
  { id: "business", label: "Run my business" },
  { id: "assistant", label: "Personal assistant" },
  { id: "build", label: "Build apps" },
  { id: "explore", label: "Just exploring" },
] as const;

export type GetStartedGoalId = (typeof GET_STARTED_GOALS)[number]["id"];

export const GET_STARTED_TOOL_IDS = [
  "github",
  "claude-code",
  "codex",
  "opencode",
  "linear",
  "jira",
  "figma",
  "gmail",
  "outlook",
  "google-calendar",
  "slack",
  "notion",
  "stripe",
  "hubspot",
  "telegram",
  "whatsapp",
  "discord",
  "email",
  "todoist",
] as const;

export type GetStartedToolId = (typeof GET_STARTED_TOOL_IDS)[number];

export interface GetStartedToolGroup {
  goal: Exclude<GetStartedGoalId, "build" | "explore">;
  title: string;
  tools: readonly { id: GetStartedToolId; label: string }[];
}

export const GET_STARTED_TOOL_GROUPS: readonly GetStartedToolGroup[] = [
  {
    goal: "code",
    title: "Your coding tools",
    tools: [
      { id: "github", label: "GitHub" },
      { id: "claude-code", label: "Claude Code" },
      { id: "codex", label: "Codex" },
      { id: "opencode", label: "OpenCode" },
      { id: "linear", label: "Linear" },
      { id: "jira", label: "Jira" },
      { id: "figma", label: "Figma" },
    ],
  },
  {
    goal: "business",
    title: "Tools you run on",
    tools: [
      { id: "gmail", label: "Gmail" },
      { id: "outlook", label: "Outlook" },
      { id: "google-calendar", label: "Google Calendar" },
      { id: "slack", label: "Slack" },
      { id: "notion", label: "Notion" },
      { id: "stripe", label: "Stripe" },
      { id: "hubspot", label: "HubSpot" },
    ],
  },
  {
    goal: "assistant",
    title: "Where should your AI reach you?",
    tools: [
      { id: "telegram", label: "Telegram" },
      { id: "whatsapp", label: "WhatsApp" },
      { id: "discord", label: "Discord" },
      { id: "email", label: "Email" },
      { id: "todoist", label: "Todoist" },
    ],
  },
];

export const GET_STARTED_APP_IDEAS = [
  { id: "habit-tracker", label: "Habit tracker", request: "Track my habits and show my streaks" },
  { id: "client-crm", label: "Client CRM", request: "Keep track of my clients, deals and follow-ups" },
  { id: "budget-planner", label: "Budget planner", request: "Plan my monthly budget and track my spending" },
  { id: "recipe-box", label: "Recipe box", request: "Save my recipes and plan my meals" },
] as const;

export type GetStartedAppIdeaId = (typeof GET_STARTED_APP_IDEAS)[number]["id"];

export const GET_STARTED_STARTERS = [
  { id: "build-something-small", label: "Build something small" },
  { id: "play-a-game", label: "Play a game" },
  { id: "ask-anything", label: "Ask anything" },
] as const;

export type GetStartedStarterId = (typeof GET_STARTED_STARTERS)[number]["id"];

export type GetStartedChoiceGroup = { kind: "starter"; goal: "explore"; title: string; options: typeof GET_STARTED_STARTERS };

const STARTER_GROUP = { kind: "starter", goal: "explore", title: "Sounds fun", options: GET_STARTED_STARTERS } as const;

/**
 * The tools step's choices that are not integrations (those connect through the marketplace on the
 * same step): the starters when exploring, or when nothing was picked. Coding agents sign in on
 * their own screen before it (spec 636), and the first app idea is picked on the App Gallery step.
 */
export function getStartedToolGroupsForGoals(goals: readonly GetStartedGoalId[]): GetStartedChoiceGroup[] {
  return goals.length === 0 || goals.includes("explore") ? [STARTER_GROUP] : [];
}

/**
 * Spec 636: the coding agents the agents screen signs in through Settings > Agents & providers, in
 * display order. OpenCode has no sign-in there yet, so it is not offered (saved answers that include
 * it still load).
 */
export const GET_STARTED_AGENTS = ["claude", "codex"] as const;
export type GetStartedAgentKind = (typeof GET_STARTED_AGENTS)[number];
const AGENT_TOOLS: Record<GetStartedAgentKind, GetStartedToolId> = { claude: "claude-code", codex: "codex" };

/** The saved tool id for a connected coding agent. */
export function getStartedToolForAgent(agent: GetStartedAgentKind): GetStartedToolId {
  return AGENT_TOOLS[agent];
}

/** The coding agent a saved tool id stands for, or null for any other tool. */
export function getStartedAgentForTool(tool: GetStartedToolId): GetStartedAgentKind | null {
  return GET_STARTED_AGENTS.find((agent) => AGENT_TOOLS[agent] === tool) ?? null;
}

const goalIds = GET_STARTED_GOALS.map((goal) => goal.id) as [GetStartedGoalId, ...GetStartedGoalId[]];
const appIdeaIds = GET_STARTED_APP_IDEAS.map((idea) => idea.id) as [GetStartedAppIdeaId, ...GetStartedAppIdeaId[]];
const starterIds = GET_STARTED_STARTERS.map((starter) => starter.id) as [GetStartedStarterId, ...GetStartedStarterId[]];

function uniqueList<T extends string>(item: z.ZodType<T>, max: number) {
  return z.array(item).max(max).default([]).transform((values) => [...new Set(values)]);
}

/** The owner's name is rendered into SOUL, so it may not carry controls or HTML comment markers. */
const NameSchema = z
  .string()
  .trim()
  .min(1)
  .max(GET_STARTED_NAME_MAX_CHARS)
  .regex(/^[^\p{Cc}]*$/u)
  .refine((value) => !value.includes("<!--") && !value.includes("-->"));

const answerShape = {
  name: NameSchema.optional(),
  goals: uniqueList(z.enum(goalIds), goalIds.length),
  tools: uniqueList(z.enum(GET_STARTED_TOOL_IDS), GET_STARTED_TOOL_IDS.length),
  appIdea: z.enum(appIdeaIds).optional(),
  starter: z.enum(starterIds).optional(),
  bot: GetStartedBotSchema.optional(),
  /** Ready-made bots to create on completion; never grants them app access. */
  bots: z.array(z.enum(GET_STARTED_RECIPE_BOT_IDS)).max(GET_STARTED_RECIPE_BOTS_MAX).optional()
    .transform((values) => (values && values.length > 0 ? [...new Set(values)] : undefined))
    .optional(),
};

export const GetStartedAnswersSchema = z.object(answerShape).strict();
export type GetStartedAnswers = z.infer<typeof GetStartedAnswersSchema>;

export const GetStartedDraftSchema = z
  .object({ ...answerShape, step: z.number().int().min(0).max(GET_STARTED_STEP_COUNT - 1).optional() })
  .strict();
export type GetStartedDraft = z.infer<typeof GetStartedDraftSchema>;

export const GetStartedUpdateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("draft"), draft: GetStartedDraftSchema }).strict(),
  z.object({ type: z.literal("complete"), answers: GetStartedAnswersSchema }).strict(),
  z.object({ type: z.literal("skip") }).strict(),
]);
export type GetStartedUpdate = z.infer<typeof GetStartedUpdateSchema>;

const IsoTimestamp = z.iso.datetime();

const pendingShape = { status: z.literal("pending") };
const inProgressShape = { status: z.literal("in_progress"), updatedAt: IsoTimestamp, draft: GetStartedDraftSchema };
const completedShape = { status: z.literal("completed"), completedAt: IsoTimestamp, answers: GetStartedAnswersSchema };
const skippedShape = { status: z.literal("skipped"), skippedAt: IsoTimestamp };

/** Persisted in the owner's `system/get-started.json`. No file means the home is not eligible. */
export const GetStartedStateSchema = z.discriminatedUnion("status", [
  z.object({ version: z.literal(1), ...pendingShape }).strict(),
  z.object({ version: z.literal(1), ...inProgressShape }).strict(),
  z.object({ version: z.literal(1), ...completedShape }).strict(),
  z.object({ version: z.literal(1), ...skippedShape }).strict(),
]);
export type GetStartedState = z.infer<typeof GetStartedStateSchema>;
export type GetStartedStatus = GetStartedState["status"];

/** `GET`/`PUT /api/settings/get-started` response: the state without its file version. */
export const GetStartedResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_eligible") }).strict(),
  z.object(pendingShape).strict(),
  z.object(inProgressShape).strict(),
  z.object(completedShape).strict(),
  z.object(skippedShape).strict(),
]);
export type GetStartedResponse = z.infer<typeof GetStartedResponseSchema>;

/**
 * `GET /api/settings/get-started/bots`: what each saved bot choice made, by recipe ID. "created"
 * names the bot its Get started request made; "pending" means that creation never finished.
 */
export const GetStartedSavedBotSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), agentId: ChatAgentIdSchema }).strict(),
  z.object({ status: z.literal("pending") }).strict(),
]);
export type GetStartedSavedBot = z.infer<typeof GetStartedSavedBotSchema>;
export const GetStartedSavedBotsResponseSchema = z.object({ bots: z.record(z.string().max(128), GetStartedSavedBotSchema) }).strict();
