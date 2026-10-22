import { agentInspirations, type AgentInspiration } from "./agent-inspirations.generated";
import { filterTemplates, type AgentTemplate } from "./agent-templates";

// What the gallery lists and how it is filtered mirrors the web's
// AgentRecipesPanel (packages/ui/src/chat-agents/AgentRecipesPanel.tsx);
// tests/ui/agent-gallery-mobile-parity.test.ts holds the two together.

/** The category that lists everything. */
export const ALL_CATEGORIES = "All";
// Everything, then the first categories of the inventory, as many as the web offers.
const CATEGORY_LIMIT = 8;

/** The categories the gallery can be narrowed to, `ALL_CATEGORIES` first. */
export const GALLERY_CATEGORIES: readonly string[] = [
  ALL_CATEGORIES,
  ...agentInspirations
    .flatMap((inspiration) => inspiration.categories)
    .filter((category, index, all) => all.indexOf(category) === index),
].slice(0, CATEGORY_LIMIT);

// Mirrors LAUNCH_BOT_RECIPE_IDS in packages/ui/src/chat-agents/recipe-handoff.ts.
/** The templates only a computer offers: an inspiration with one of these ids is never listed. */
export const LAUNCH_RECIPE_IDS: readonly string[] = [
  "matrix-bot", "jev-inbox-triage", "personal-daily-brief", "competitor-watching", "account-book",
  "event-request-desk", "writing-bot", "echo", "spend-review",
];

export interface AgentGalleryFilter {
  query: string;
  /** One of `GALLERY_CATEGORIES`. */
  category: string;
}

export interface AgentGallery<T extends AgentTemplate> {
  /** The computer's templates, which an agent is created from. */
  templates: T[];
  /** The inspirations shipped with the app, which are built in chat. */
  inspirations: AgentInspiration[];
}

function inCategory(inspiration: AgentInspiration, category: string): boolean {
  return category === ALL_CATEGORIES || inspiration.categories.includes(category);
}

function matchesQuery(inspiration: AgentInspiration, wanted: string): boolean {
  if (!wanted) return true;
  return [
    inspiration.name,
    inspiration.description,
    ...inspiration.categories,
    ...inspiration.skills,
    ...inspiration.integrations,
  ].some((value) => value.toLocaleLowerCase().includes(wanted));
}

/**
 * The gallery a new agent starts from: the computer's templates, then every
 * inspiration the computer has no template of its own for. A template has no
 * category, so it takes those of the inspiration it shares an id with.
 */
export function buildAgentGallery<T extends AgentTemplate>(
  templates: readonly T[],
  { query, category }: AgentGalleryFilter,
): AgentGallery<T> {
  const wanted = query.trim().toLocaleLowerCase();
  const filed = templates.filter((template) => (
    category === ALL_CATEGORIES
    || agentInspirations.some((inspiration) => (
      inspiration.id === template.recipeId && inCategory(inspiration, category)
    ))
  ));

  return {
    templates: filterTemplates(filed, query),
    inspirations: agentInspirations.filter((inspiration) => (
      inCategory(inspiration, category)
      && !LAUNCH_RECIPE_IDS.includes(inspiration.id)
      && !templates.some((template) => template.recipeId === inspiration.id)
      && matchesQuery(inspiration, wanted)
    )),
  };
}

// Mirrors buildAgentRecipePrompt in packages/ui/src/chat-agents/recipe-handoff.ts.
/** The prompt that builds an agent like the inspiration in an ordinary chat. */
export function inspirationSetupPrompt(
  inspiration: Pick<AgentInspiration, "name" | "description" | "skills" | "integrations">,
): string {
  const capabilities = inspiration.skills.slice(0, 5).join(", ");
  const integrations = inspiration.integrations.slice(0, 5).join(", ");
  return `Help me create a Matrix agent inspired by “${inspiration.name}”. ${inspiration.description} `
    + "Start by asking me the few decisions needed to tailor it. "
    + `Suggested capabilities: ${capabilities || "none listed"}. `
    + `Possible integrations: ${integrations || "none listed"}. `
    + "Do not copy third-party private prompts; build an original agent for my needs.";
}
