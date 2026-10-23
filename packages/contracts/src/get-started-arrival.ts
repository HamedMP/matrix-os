import { appGalleryBuildPrompt } from "#app-gallery";
import { GET_STARTED_APP_IDEAS, type GetStartedAnswers, type GetStartedGoalId, type GetStartedStarterId, type GetStartedToolId } from "#get-started";
import { getStartedServiceLabel, getStartedToolConnect } from "#get-started-connect";
import { GET_STARTED_RECIPE_BOTS, type GetStartedRecipeBotId } from "#get-started-recipe-bots";
import {
  GETTING_STARTED_STEP_IDS,
  type GettingStartedSnapshot,
  type GettingStartedStep,
  type GettingStartedStepId,
  type GettingStartedStepStatus,
} from "#getting-started";
import { ONBOARDING_TASK_IDS, type OnboardingStarterTaskId } from "#onboarding-widget-catalog";

// Spec 635, Section 5: the desktop a new owner lands on leads with what fits
// their goals. Completion detection stays as it is, so a label only names what
// its check counts.

const STEP_PRIORITY: Record<GetStartedGoalId, readonly GettingStartedStepId[]> = {
  code: ["agent", "github", "first-work"],
  business: ["email-calendar", "first-work"],
  assistant: ["email-calendar", "first-work"],
  build: ["first-work", "github"],
  explore: [],
};

const TASK_PRIORITY: Record<GetStartedGoalId, readonly OnboardingStarterTaskId[]> = {
  code: ["work-on-code"],
  business: ["plan-week", "research"],
  assistant: ["plan-week", "research"],
  build: ["build-website"],
  explore: [],
};

function merge<T extends string>(goals: readonly GetStartedGoalId[], priority: Record<GetStartedGoalId, readonly T[]>, all: readonly T[]): T[] {
  const ordered = new Set<T>();
  for (const goal of goals) for (const id of priority[goal]) ordered.add(id);
  for (const id of all) ordered.add(id);
  return [...ordered];
}

export function getStartedStepOrder(goals: readonly GetStartedGoalId[]): GettingStartedStepId[] {
  return merge(goals, STEP_PRIORITY, GETTING_STARTED_STEP_IDS);
}

// Tasks a picked tool or starter unlocks lead, ahead of the goal order.
const TOOL_TASKS: Partial<Record<GetStartedToolId, OnboardingStarterTaskId>> = {
  "google-calendar": "plan-week",
  github: "work-on-code",
};

const STARTER_TASKS: Partial<Record<GetStartedStarterId, OnboardingStarterTaskId>> = {
  "ask-anything": "research",
  "build-something-small": "build-website",
};

export function getStartedTaskOrder(
  goals: readonly GetStartedGoalId[],
  choices: { tools?: readonly GetStartedToolId[]; starter?: GetStartedStarterId } = {},
): OnboardingStarterTaskId[] {
  const chosen = [
    ...(choices.tools ?? []).map((tool) => TOOL_TASKS[tool]),
    choices.starter ? STARTER_TASKS[choices.starter] : undefined,
  ].filter((task): task is OnboardingStarterTaskId => task !== undefined);
  return [...new Set([...chosen, ...merge(goals, TASK_PRIORITY, ONBOARDING_TASK_IDS)])];
}

// The agent step completes for Codex or Claude only (deriveGettingStartedSnapshot).
const CHECKED_AGENTS: readonly { id: GetStartedToolId; label: string; agent: string }[] = [
  { id: "claude-code", label: "Claude Code", agent: "claude" },
  { id: "codex", label: "Codex", agent: "codex" },
];

/**
 * Getting started for this owner: their goals first, and the coding agents they picked by name.
 * A named agent step is done only when one of those agents is signed in (`availableAgents`).
 */
export function personalizeGettingStartedSteps(
  steps: readonly GettingStartedStep[],
  answers: Pick<GetStartedAnswers, "goals" | "tools">,
  availableAgents: readonly string[] | null = null,
): GettingStartedStep[] {
  const picked = CHECKED_AGENTS.filter((agent) => answers.tools.includes(agent.id));
  const named = (step: GettingStartedStep): GettingStartedStep => {
    const label = `Log in to ${picked.map((agent) => agent.label).join(" / ")}`;
    if (!availableAgents || step.status === "unavailable") return { ...step, label };
    const ready = picked.some((agent) => availableAgents.includes(agent.agent));
    return { ...step, label, status: ready ? "complete" : "incomplete" };
  };
  const labelled = picked.length ? steps.map((step) => (step.id === "agent" ? named(step) : step)) : steps;
  return orderByIds(labelled, getStartedStepOrder(answers.goals));
}

// Services the five steps already check, so they never get a second row.
const STEP_SERVICES = new Set(["github", "gmail", "google_calendar"]);

export type GettingStartedRow =
  | ({ kind: "step" } & GettingStartedStep)
  | { kind: "tool"; id: `tool:${string}`; label: string; status: GettingStartedStepStatus; service: string }
  | { kind: "bot"; id: `bot:${string}`; label: string; status: GettingStartedStepStatus; recipeId: GetStartedRecipeBotId; create?: true };

/**
 * Each added bot's chat status: "missing" when its creation failed (it can be created again),
 * null when the owner has removed that bot. An absent entry means not loaded yet.
 */
export type GettingStartedBotStatuses = Partial<Record<GetStartedRecipeBotId, GettingStartedStepStatus | "missing" | null>>;

/**
 * Getting started for this owner: the five steps (personalised by their answers), then a
 * connect row per picked tool the steps don't cover, then a chat row per bot they added.
 */
export function gettingStartedRows(
  snapshot: GettingStartedSnapshot,
  answers: Pick<GetStartedAnswers, "goals" | "tools" | "bots"> | null,
  bots: GettingStartedBotStatuses = {},
): { rows: GettingStartedRow[]; completedCount: number; total: number } {
  const steps = answers ? personalizeGettingStartedSteps(snapshot.steps, answers, snapshot.availableAgents) : snapshot.steps;
  const rows: GettingStartedRow[] = steps.map((step) => ({ kind: "step", ...step }));
  const connected = snapshot.connectedServices ? new Set(snapshot.connectedServices) : null;
  for (const tool of answers?.tools ?? []) {
    const connect = getStartedToolConnect(tool);
    if (connect.kind !== "app" || STEP_SERVICES.has(connect.service)) continue;
    const status = connected ? (connected.has(connect.service) ? "complete" : "incomplete") : "unavailable";
    rows.push({ kind: "tool", id: `tool:${connect.service}`, label: `Connect ${getStartedServiceLabel(connect.service)}`, status, service: connect.service });
  }
  for (const recipeId of answers?.bots ?? []) {
    const status = bots[recipeId];
    const bot = GET_STARTED_RECIPE_BOTS.find((candidate) => candidate.recipeId === recipeId);
    if (status === null || !bot) continue;
    if (status === "missing") {
      // Spec 635: a chosen bot that failed to create stays visible, with a way to create it again.
      rows.push({ kind: "bot", id: `bot:${recipeId}`, label: `Create ${bot.label}`, status: "incomplete", recipeId, create: true });
      continue;
    }
    rows.push({ kind: "bot", id: `bot:${recipeId}`, label: `Chat with ${bot.label}`, status: status ?? "incomplete", recipeId });
  }
  return { rows, completedCount: rows.filter((row) => row.status === "complete").length, total: rows.length };
}

/** Stable reorder: listed ids first in that order, everything else after in its original order. */
export function orderByIds<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.id) ?? order.length + index }))
    .sort((left, right) => left.rank - right.rank)
    .map(({ item }) => item);
}

const WIDGET_INTROS: Partial<Record<GetStartedGoalId, string>> = {
  code: "Want me to open one of your repos and run its tests? Nothing changes until you say so.",
  build: "Want me to build your first app? I'll show you what I'm doing as I go.",
  business: "Want me to plan your week or look something up for you?",
  assistant: "Want me to plan your week? I'll ask before I touch your calendar.",
};

/** The widget's first line for the owner's first goal; null keeps today's introduction. */
export function getStartedWidgetIntro(goals: readonly GetStartedGoalId[]): string | null {
  const first = goals[0];
  return (first && WIDGET_INTROS[first]) ?? null;
}

/** Getting started's App Gallery link: the owner's picked app idea, or their first app. */
export function getStartedAppGalleryLabel(answers: Pick<GetStartedAnswers, "appIdea"> | null): string {
  const idea = GET_STARTED_APP_IDEAS.find((candidate) => candidate.id === answers?.appIdea);
  return idea ? `Build your ${idea.label.toLowerCase()}` : "Build your first app";
}

export interface GetStartedBuildSuggestion {
  title: string;
  prompt: string;
}

/** The first app idea from Get started, as App Gallery's own build request. */
export function getStartedBuildSuggestion(answers: GetStartedAnswers): GetStartedBuildSuggestion | null {
  const idea = GET_STARTED_APP_IDEAS.find((candidate) => candidate.id === answers.appIdea);
  const prompt = idea ? appGalleryBuildPrompt(idea.request) : null;
  return idea && prompt ? { title: idea.label, prompt } : null;
}
