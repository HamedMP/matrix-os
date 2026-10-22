import {
  GET_STARTED_NAME_MAX_CHARS,
  getStartedToolGroupsForGoals,
  type GetStartedAnswers,
  type GetStartedAppIdeaId,
  type GetStartedDraft,
  type GetStartedGoalId,
  type GetStartedStarterId,
  type GetStartedToolId,
} from "#get-started";
import {
  DEFAULT_GET_STARTED_BOT,
  GET_STARTED_BOT_NAME_MAX_CHARS,
  GET_STARTED_BOT_RULES_MAX_CHARS,
  GetStartedBotSchema,
  type GetStartedBot,
} from "#get-started-bot";
import { getStartedRecipeBotIdsForGoals, type GetStartedRecipeBotId } from "#get-started-recipe-bots";

// Spec 635, Section 3: the wizard's client state machine. It is shared by
// every desktop surface so they cannot drift; hosts only load and save.

export const GET_STARTED_WIZARD_STEPS = ["name", "goals", "tools", "ai", "gallery", "bots", "summary"] as const;
export type GetStartedWizardStep = (typeof GET_STARTED_WIZARD_STEPS)[number];

export interface GetStartedWizardState {
  step: GetStartedWizardStep;
  /** Raw text while typing; trimmed and validated only when it becomes an answer. */
  name: string;
  goals: GetStartedGoalId[];
  tools: GetStartedToolId[];
  appIdea?: GetStartedAppIdeaId;
  starter?: GetStartedStarterId;
  /** The AI's name and style while editing; saved only once the owner confirms that step. */
  bot: GetStartedBot;
  botChosen: boolean;
  /** Ready-made bots added on the last screen. */
  bots: GetStartedRecipeBotId[];
}

export type GetStartedWizardEvent =
  | { type: "next" }
  | { type: "back" }
  | { type: "skip" }
  | { type: "name"; value: string }
  | { type: "toggle-goal"; goal: GetStartedGoalId }
  | { type: "toggle-tool"; tool: GetStartedToolId }
  | { type: "pick-app-idea"; id: GetStartedAppIdeaId }
  | { type: "pick-starter"; id: GetStartedStarterId }
  | { type: "bot"; patch: Partial<GetStartedBot> }
  | { type: "toggle-bot"; id: GetStartedRecipeBotId };

const QUESTION_COUNT = GET_STARTED_WIZARD_STEPS.indexOf("summary");

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
}

function move(state: GetStartedWizardState, delta: 1 | -1): GetStartedWizardState {
  const index = GET_STARTED_WIZARD_STEPS.indexOf(state.step) + delta;
  const step = GET_STARTED_WIZARD_STEPS[Math.max(0, Math.min(GET_STARTED_WIZARD_STEPS.length - 1, index))] ?? state.step;
  return step === state.step ? state : { ...state, step };
}

function clearStep(state: GetStartedWizardState): GetStartedWizardState {
  switch (state.step) {
    case "name": return { ...state, name: "" };
    case "goals": return { ...state, goals: [] };
    case "tools": return { ...state, tools: [], appIdea: undefined, starter: undefined };
    case "ai": return { ...state, bot: DEFAULT_GET_STARTED_BOT, botChosen: false };
    case "gallery": return { ...state, appIdea: undefined };
    case "bots": return { ...state, bots: [] };
    case "summary": return state;
  }
}

export function initialGetStartedWizard(draft?: GetStartedDraft): GetStartedWizardState {
  const step = draft?.step === undefined ? undefined : GET_STARTED_WIZARD_STEPS[draft.step];
  return {
    step: step ?? "name",
    name: draft?.name ?? "",
    goals: [...(draft?.goals ?? [])],
    tools: [...(draft?.tools ?? [])],
    ...(draft?.appIdea ? { appIdea: draft.appIdea } : {}),
    ...(draft?.starter ? { starter: draft.starter } : {}),
    bot: draft?.bot ?? DEFAULT_GET_STARTED_BOT,
    botChosen: Boolean(draft?.bot),
    bots: [...(draft?.bots ?? [])],
  };
}

export function reduceGetStartedWizard(state: GetStartedWizardState, event: GetStartedWizardEvent): GetStartedWizardState {
  switch (event.type) {
    case "next": return move(state.step === "ai" ? { ...state, botChosen: true } : state, 1);
    case "back": return move(state, -1);
    case "skip": return move(clearStep(state), 1);
    case "name": return { ...state, name: event.value.slice(0, GET_STARTED_NAME_MAX_CHARS) };
    case "toggle-goal": return { ...state, goals: toggle(state.goals, event.goal) };
    case "toggle-tool": return { ...state, tools: toggle(state.tools, event.tool) };
    case "pick-app-idea": return { ...state, appIdea: state.appIdea === event.id ? undefined : event.id };
    case "pick-starter": return { ...state, starter: state.starter === event.id ? undefined : event.id };
    case "toggle-bot": return { ...state, bots: toggle(state.bots, event.id) };
    case "bot": {
      const bot = { ...state.bot, ...event.patch };
      bot.name = bot.name.slice(0, GET_STARTED_BOT_NAME_MAX_CHARS);
      if (bot.rules !== undefined) bot.rules = bot.rules.slice(0, GET_STARTED_BOT_RULES_MAX_CHARS);
      return { ...state, bot };
    }
  }
}

/** Answers limited to what is still on screen for the chosen goals, in the server's shape. */
export function getStartedAnswersFromWizard(state: GetStartedWizardState): GetStartedAnswers {
  const groups = getStartedToolGroupsForGoals(state.goals);
  const visibleTools = new Set(groups.flatMap((group) => (group.kind === "tools" ? group.tools.map((tool) => tool.id) : [])));
  const name = state.name.replace(/\p{Cc}/gu, "").replaceAll("<!--", "").replaceAll("-->", "").trim();
  const answers: GetStartedAnswers = {
    goals: [...state.goals],
    tools: state.tools.filter((tool) => visibleTools.has(tool)),
  };
  if (name) answers.name = name;
  // App Gallery shows the ideas to everyone, so a pick stands whatever the goals.
  if (state.appIdea) answers.appIdea = state.appIdea;
  if (state.starter && groups.some((group) => group.kind === "starter")) answers.starter = state.starter;
  const suggested = new Set(getStartedRecipeBotIdsForGoals(state.goals));
  const bots = state.bots.filter((id) => suggested.has(id));
  if (bots.length > 0) answers.bots = bots;
  if (state.botChosen) {
    const bot = getStartedBotFromWizard(state.bot);
    if (bot) answers.bot = bot;
  }
  return answers;
}

/** The bot as the server accepts it: blank name falls back to Matrix, blank rules are dropped, markers removed. */
export function getStartedBotFromWizard(bot: GetStartedBot): GetStartedBot | null {
  const clean = (text: string) => text.replace(/\p{Cc}/gu, " ").replaceAll("<!--", "").replaceAll("-->", "").trim();
  const name = clean(bot.name) || DEFAULT_GET_STARTED_BOT.name;
  const rules = bot.rules === undefined ? "" : clean(bot.rules);
  const { rules: _rules, ...rest } = bot;
  const parsed = GetStartedBotSchema.safeParse({ ...rest, name, ...(rules ? { rules } : {}) });
  return parsed.success ? parsed.data : null;
}

export function getStartedDraftFromWizard(state: GetStartedWizardState): GetStartedDraft {
  return { step: GET_STARTED_WIZARD_STEPS.indexOf(state.step), ...getStartedAnswersFromWizard(state) };
}

/** Progress bars cover the questions; the summary shows them all done. */
export function getStartedQuestionProgress(state: GetStartedWizardState): { current: number; total: number } {
  return { current: GET_STARTED_WIZARD_STEPS.indexOf(state.step), total: QUESTION_COUNT };
}
