import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";

const AppSuggestionSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const SkillSuggestionSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const PersonalityConfigSchema = z.object({
  vibe: z.string(),
  traits: z.array(z.string()),
});

const SetupPlanSchema = z.object({
  role: z.string(),
  customDescription: z.string().optional(),
  apps: z.array(AppSuggestionSchema),
  skills: z.array(SkillSuggestionSchema),
  personality: PersonalityConfigSchema,
  status: z.enum(["pending", "building", "complete"]),
  built: z.array(z.string()),
});

export type AppSuggestion = z.infer<typeof AppSuggestionSchema>;
export type SkillSuggestion = z.infer<typeof SkillSuggestionSchema>;
export type PersonalityConfig = z.infer<typeof PersonalityConfigSchema>;
export type SetupPlan = z.infer<typeof SetupPlanSchema>;
export { SetupPlanSchema };

export interface PersonaSuggestions {
  apps: AppSuggestion[];
  skills: SkillSuggestion[];
  personality: PersonalityConfig;
}

const PLAN_FILE = "setup-plan.json";

export function parseSetupPlan(homePath: string): SetupPlan | null {
  const filePath = join(homePath, "system", PLAN_FILE);
  if (!existsSync(filePath)) return null;

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const result = SetupPlanSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function writeSetupPlan(homePath: string, plan: SetupPlan): void {
  const filePath = join(homePath, "system", PLAN_FILE);
  writeFileSync(filePath, JSON.stringify(plan, null, 2));
}

const PERSONAS: Record<string, PersonaSuggestions> = {
  student: {
    apps: [
      { name: "Study Planner", description: "Weekly schedule with assignment deadlines and exam dates" },
      { name: "Flashcards", description: "Spaced repetition flashcard app for study topics" },
      { name: "Budget Tracker", description: "Simple student budget tracker with categories" },
    ],
    skills: [
      { name: "summarize", description: "Summarize papers, articles, and lecture notes" },
      { name: "reminder", description: "Deadline and study session reminders" },
    ],
    personality: { vibe: "casual", traits: ["encouraging", "clear", "patient"] },
  },
  developer: {
    apps: [
      { name: "Project Board", description: "Kanban board for tracking tasks and sprints" },
      { name: "Snippet Library", description: "Searchable code snippet collection" },
      { name: "Time Tracker", description: "Track hours spent on projects and tasks" },
    ],
    skills: [
      { name: "code-review", description: "Review code for bugs and improvements" },
      { name: "git-workflow", description: "Git branching, PR, and release workflows" },
    ],
    personality: { vibe: "concise", traits: ["technical", "pragmatic", "direct"] },
  },
  investor: {
    apps: [
      { name: "Portfolio Dashboard", description: "Track holdings, allocation, and performance" },
      { name: "Trade Journal", description: "Log trades with rationale and outcomes" },
      { name: "Watchlist", description: "Track assets and price alerts" },
    ],
    skills: [
      { name: "market-news", description: "Latest financial news and market updates" },
      { name: "financial-analysis", description: "Analyze financial data and metrics" },
    ],
    personality: { vibe: "precise", traits: ["data-driven", "analytical", "timely"] },
  },
  entrepreneur: {
    apps: [
      { name: "CRM", description: "Track customers, leads, and interactions" },
      { name: "Revenue Dashboard", description: "Revenue, expenses, and key metrics" },
      { name: "Task Board", description: "Prioritized task management with deadlines" },
    ],
    skills: [
      { name: "competitive-analysis", description: "Research competitors and market position" },
      { name: "email-drafts", description: "Draft professional emails and outreach" },
    ],
    personality: { vibe: "action-oriented", traits: ["strategic", "supportive", "decisive"] },
  },
  parent: {
    apps: [
      { name: "Family Calendar", description: "Shared family schedule with events and activities" },
      { name: "Meal Planner", description: "Weekly meal planning with recipes" },
      { name: "Grocery List", description: "Shopping list with categories and checkoffs" },
    ],
    skills: [
      { name: "recipe-finder", description: "Find recipes by ingredients or cuisine" },
      { name: "reminder", description: "Reminders for appointments, pickups, and tasks" },
    ],
    personality: { vibe: "warm", traits: ["practical", "organized", "supportive"] },
  },
  creative: {
    apps: [
      { name: "Project Portfolio", description: "Track creative projects and progress" },
      { name: "Inspiration Board", description: "Collect references, ideas, and inspiration" },
      { name: "Client Tracker", description: "Manage clients, commissions, and invoices" },
    ],
    skills: [
      { name: "brainstorm", description: "Generate ideas and creative directions" },
      { name: "reference-finder", description: "Find visual and conceptual references" },
    ],
    personality: { vibe: "expressive", traits: ["encouraging", "flexible", "imaginative"] },
  },
  researcher: {
    apps: [
      { name: "Paper Tracker", description: "Track papers to read, reading notes, citations" },
      { name: "Research Notes", description: "Structured research notes with tags" },
      { name: "Experiment Log", description: "Log experiments, hypotheses, and results" },
    ],
    skills: [
      { name: "summarize", description: "Summarize academic papers and reports" },
      { name: "paper-search", description: "Search for papers by topic or author" },
    ],
    personality: { vibe: "precise", traits: ["thorough", "analytical", "methodical"] },
  },
};

const DEFAULT_PERSONA: PersonaSuggestions = {
  apps: [
    { name: "Task Manager", description: "Simple task list with priorities and due dates" },
    { name: "Notes", description: "Quick notes and reference material" },
    { name: "Daily Journal", description: "Daily entries for thoughts and reflections" },
  ],
  skills: [
    { name: "summarize", description: "Summarize articles and long text" },
    { name: "reminder", description: "Set reminders for tasks and events" },
  ],
  personality: { vibe: "adaptive", traits: ["helpful", "curious", "friendly"] },
};

const ROLE_KEYWORDS: Record<string, string[]> = {
  student: ["student", "studying", "university", "college", "school", "undergrad", "graduate", "phd"],
  developer: ["developer", "programmer", "engineer", "software", "coding", "coder", "devops", "frontend", "backend"],
  investor: ["investor", "trader", "trading", "stocks", "crypto", "finance", "portfolio", "investment"],
  entrepreneur: ["entrepreneur", "founder", "startup", "business owner", "ceo", "business"],
  parent: ["parent", "mom", "dad", "mommy", "daddy", "mother", "father", "stay-at-home", "caregiver"],
  creative: ["creative", "writer", "designer", "artist", "musician", "photographer", "filmmaker", "illustrator"],
  researcher: ["researcher", "academic", "scientist", "professor", "research", "scholar", "postdoc"],
};

function matchRole(input: string): string | null {
  const lower = input.toLowerCase();
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return role;
    }
  }
  return null;
}

export function getPersonaSuggestions(role: string): PersonaSuggestions {
  const lower = role.toLowerCase();

  if (PERSONAS[lower]) return PERSONAS[lower];

  const matched = matchRole(lower);
  if (matched) return PERSONAS[matched];

  return DEFAULT_PERSONA;
}
