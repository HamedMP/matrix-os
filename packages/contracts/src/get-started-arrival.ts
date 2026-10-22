import { appGalleryBuildPrompt } from "#app-gallery";
import { GET_STARTED_APP_IDEAS, type GetStartedAnswers, type GetStartedGoalId, type GetStartedToolId } from "#get-started";
import { GETTING_STARTED_STEP_IDS, type GettingStartedStep, type GettingStartedStepId } from "#getting-started";
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

export function getStartedTaskOrder(goals: readonly GetStartedGoalId[]): OnboardingStarterTaskId[] {
  return merge(goals, TASK_PRIORITY, ONBOARDING_TASK_IDS);
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
