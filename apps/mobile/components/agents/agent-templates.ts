/** What the new-agent screens show of a template. A `BotRecipeSummary` is one. */
export interface AgentTemplate {
  recipeId: string;
  version: string;
  name: string;
  description: string;
  /** Decides the mascot's colour. Templates from the server have none. */
  category?: string;
}

/** The templates whose name or description contains `query`, whatever the case. */
export function filterTemplates<T extends AgentTemplate>(templates: readonly T[], query: string): T[] {
  const wanted = query.trim().toLocaleLowerCase();
  if (!wanted) return [...templates];
  return templates.filter((template) => (
    [template.name, template.description].some((value) => value.toLocaleLowerCase().includes(wanted))
  ));
}

// Mirrors buildAgentRecipePrompt in packages/ui/src/chat-agents/recipe-handoff.ts.
// The web's sentence on capabilities and integrations is left out: the
// template list carries neither.
/** The prompt that sets a template up in an ordinary chat instead of creating it. */
export function templateSetupPrompt(template: Pick<AgentTemplate, "name" | "description">): string {
  const description = template.description.trim();
  const sentence = description && !/[.!?…]$/.test(description) ? `${description}.` : description;
  return [
    `Help me create a Matrix agent inspired by “${template.name}”.`,
    sentence,
    "Start by asking me the few decisions needed to tailor it.",
    "Do not copy third-party private prompts; build an original agent for my needs.",
  ].filter(Boolean).join(" ");
}
