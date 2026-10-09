export const ONBOARDING_TASK_IDS = ["research", "plan-week", "build-website", "work-on-code"] as const;
export type OnboardingStarterTaskId = (typeof ONBOARDING_TASK_IDS)[number];
export type OnboardingTaskId = OnboardingStarterTaskId | "custom";

export const ONBOARDING_FREEFORM_MAX_CHARS = 2_000;

export type OnboardingRequiredService = "google_calendar" | "github";

export interface OnboardingAppRequirement {
  service: OnboardingRequiredService;
  name: string;
  tag: string;
  ask: string;
  access: string;
}

export interface OnboardingTaskQuestion {
  text: string;
  chips: readonly string[];
  placeholder: string;
}

export interface OnboardingTaskDefinition {
  id: OnboardingStarterTaskId;
  label: string;
  tone: "research" | "plan" | "website" | "code";
  needs?: OnboardingAppRequirement;
  question?: OnboardingTaskQuestion;
  readyLine: string;
  readyBubble: string;
  failedStep: string;
  followUp: { question?: string; chips: readonly string[] };
}

export const ONBOARDING_TASKS: readonly OnboardingTaskDefinition[] = [
  {
    id: "research",
    label: "Research anything",
    tone: "research",
    question: {
      text: "Sure. What topic?",
      chips: ["AI agent pricing", "Best CRM for startups", "Trip ideas for Lisbon"],
      placeholder: "Type a topic…",
    },
    readyLine: "Your brief is ready.",
    readyBubble: "Your brief is ready",
    failedStep: "Couldn't write the brief",
    followUp: { question: "Watch this topic weekly?", chips: ["Yes", "Not now"] },
  },
  {
    id: "plan-week",
    label: "Plan my week",
    tone: "plan",
    needs: {
      service: "google_calendar",
      name: "Google Calendar",
      tag: "Needs Calendar",
      ask: "I need your calendar for this.",
      access: "Read-only",
    },
    readyLine: "Your week is ready.",
    readyBubble: "Your week is ready",
    failedStep: "Couldn't draft your week",
    followUp: { question: "Do this every Monday?", chips: ["Yes", "Not now"] },
  },
  {
    id: "build-website",
    label: "Build a website",
    tone: "website",
    question: {
      text: "What's it for?",
      chips: ["Portfolio", "Landing page", "Event page", "Blog"],
      placeholder: "Or describe it…",
    },
    readyLine: "Your site is live.",
    readyBubble: "Your site is live",
    failedStep: "Couldn't publish it",
    followUp: { chips: ["Change colors", "Add a page"] },
  },
  {
    id: "work-on-code",
    label: "Work on my code",
    tone: "code",
    needs: {
      service: "github",
      name: "GitHub",
      tag: "Needs GitHub",
      ask: "I need GitHub for this.",
      access: "Only repos you pick",
    },
    readyLine: "Ready. What should I do?",
    readyBubble: "Your repo is ready",
    failedStep: "Couldn't open the repo",
    followUp: { chips: ["Explain this repo", "Fix a bug", "Add a feature"] },
  },
];

export const ONBOARDING_REPO_QUESTION = { text: "Which repo?", placeholder: "Or paste a repo URL…" } as const;

export function onboardingTask(taskId: OnboardingTaskId): OnboardingTaskDefinition | undefined {
  return ONBOARDING_TASKS.find((task) => task.id === taskId);
}

export function onboardingResultTitle(taskId: OnboardingTaskId, answer: string): string {
  switch (taskId) {
    case "plan-week": return "Week plan";
    case "research":
    case "build-website":
    case "work-on-code": return answer || onboardingTask(taskId)?.label || "Your result";
    case "custom": return "Your result";
  }
}

export function onboardingWorkingLine(taskId: OnboardingTaskId, answer: string): string {
  switch (taskId) {
    case "research": return `Researching ${answer}`;
    case "plan-week": return "Planning your week";
    case "build-website": return `Building your ${answer.toLocaleLowerCase()}`;
    case "work-on-code": return `Reading ${answer}`;
    case "custom": return answer;
  }
}

export interface OnboardingPromptInput {
  taskId: OnboardingTaskId;
  answer: string;
  appConnected: boolean;
  simpler: boolean;
  context?: string;
}

const BRIEF_RULES = "Keep the final answer short: a one-line headline, then at most five bullet points.";

export function buildOnboardingPrompt({ taskId, answer, appConnected, simpler, context }: OnboardingPromptInput): string {
  switch (taskId) {
    case "research":
      return simpler
        ? `Give me a quick overview of ${answer} from what you already know. ${BRIEF_RULES}`
        : `Research ${answer}. Search the web, read the most useful sources, and write a short sourced brief with links. ${BRIEF_RULES}`;
    case "plan-week":
      if (appConnected && !simpler) {
        return `Plan my week using my Google Calendar data: read this week's events, find free time, and draft focus blocks. Point out any clashes. ${BRIEF_RULES}`;
      }
      return `Draft a simple plan for my week with three focus blocks per day and room for meetings. ${BRIEF_RULES}`;
    case "build-website":
      return simpler
        ? `Build a one-page ${answer} website as a Matrix app with placeholder content.`
        : `Build a ${answer} website for me as a Matrix app, write the copy, and publish it. Reply with the link.`;
    case "work-on-code":
      return simpler
        ? `Give me a short overview of the ${answer} repository.`
        : `Clone the ${context ?? answer} repository into a project, read it, and tell me in three lines what it does. Then wait for my next instruction.`;
    case "custom":
      return answer;
  }
}

export function onboardingFollowUpPrompt(taskId: OnboardingTaskId, choice: string, answer: string): string | null {
  if (choice === "Not now") return null;
  switch (taskId) {
    case "research": return `Watch ${answer} for me and send me an updated brief every week.`;
    case "plan-week": return "Do this every Monday at 8:00.";
    case "work-on-code": return `${choice} in the ${answer} repository.`;
    case "build-website":
    case "custom": return choice;
  }
}

const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

export function parseOnboardingRepoUrl(value: string): { url: string; name: string } | null {
  const match = REPO_URL.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  return { url: `https://github.com/${match[1]}/${match[2]}`, name: match[2] };
}
