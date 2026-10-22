import { z } from "zod/v4";
import { GetStartedBotSchema } from "#get-started-bot";

// Spec 635: the Get started wizard. Answers are stable IDs from this catalog,
// never display strings, so the gateway can validate them and later layers
// (ordering, connect, SOUL) can map them without parsing free text.

export const GET_STARTED_NAME_MAX_CHARS = 40;
export const GET_STARTED_DRAFT_MAX_BYTES = 4 * 1024;
/** Name, goals, tools, the AI's name and style, and the summary: the last step index is this minus one. */
export const GET_STARTED_STEP_COUNT = 5;

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

export type GetStartedChoiceGroup =
  | ({ kind: "tools" } & GetStartedToolGroup)
  | { kind: "app-idea"; goal: "build"; title: string; options: typeof GET_STARTED_APP_IDEAS }
  | { kind: "starter"; goal: "explore"; title: string; options: typeof GET_STARTED_STARTERS };

const APP_IDEA_GROUP = { kind: "app-idea", goal: "build", title: "First app idea", options: GET_STARTED_APP_IDEAS } as const;
const STARTER_GROUP = { kind: "starter", goal: "explore", title: "Sounds fun", options: GET_STARTED_STARTERS } as const;

/** The step 3 groups in the order the owner picked their goals; exploring when nothing was picked. */
export function getStartedToolGroupsForGoals(goals: readonly GetStartedGoalId[]): GetStartedChoiceGroup[] {
  const groups: GetStartedChoiceGroup[] = [];
  for (const goal of goals) {
    if (goal === "build") groups.push(APP_IDEA_GROUP);
    else if (goal === "explore") groups.push(STARTER_GROUP);
    else {
      const group = GET_STARTED_TOOL_GROUPS.find((candidate) => candidate.goal === goal);
      if (group) groups.push({ kind: "tools", ...group });
    }
  }
  return groups.length > 0 ? groups : [STARTER_GROUP];
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
