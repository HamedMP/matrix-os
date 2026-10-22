import type { GetStartedAnswers, GetStartedGoalId, GetStartedToolId } from "#get-started";
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
const CHECKED_AGENTS: readonly { id: GetStartedToolId; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

/** Getting started for this owner: their goals first, and the coding agents they picked by name. */
export function personalizeGettingStartedSteps(
  steps: readonly GettingStartedStep[],
  answers: Pick<GetStartedAnswers, "goals" | "tools">,
): GettingStartedStep[] {
  const agents = CHECKED_AGENTS.filter((agent) => answers.tools.includes(agent.id)).map((agent) => agent.label);
  const labelled = agents.length
    ? steps.map((step) => (step.id === "agent" ? { ...step, label: `Log in to ${agents.join(" / ")}` } : step))
    : steps;
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
