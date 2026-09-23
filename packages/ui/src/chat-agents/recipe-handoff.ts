import { agentInspirations, type AgentInspiration } from "./agent-inspirations.generated.js";
import { matrixRecipes } from "./matrix-recipes.generated.js";

export function buildAgentRecipePrompt(recipe: AgentInspiration) {
  const capabilities = recipe.skills.slice(0, 5).join(", ");
  const integrations = recipe.integrations.slice(0, 5).join(", ");
  return `Help me create a Matrix agent inspired by “${recipe.name}”. ${recipe.description} Start by asking me the few decisions needed to tailor it. Suggested capabilities: ${capabilities || "none listed"}. Possible integrations: ${integrations || "none listed"}. Do not copy third-party private prompts; build an original agent for my needs.`;
}

export function buildJevInboxTriagePrompt() {
  return `Help me create a Matrix agent named Jev Inbox Triage. Use an available Hermes model and pin the matrix-jev-email-triage and matrix-integrations skills. Add Gmail as its integration, asking me to choose an account only if more than one is connected. The agent should classify inbox messages with Matrix-funded Jev, show proposed labels first, and change labels or archive only when I explicitly authorize those actions. It must never send, reply, forward, trash, delete, or mark mail read. Set the expected output to the selected account, messages examined, labels proposed or applied, archives, Review cases, and failures without full email bodies. Create the reusable agent; do not run triage or modify Gmail during setup.`;
}


export function resolveRecipeHandoff(id: string | null): { id: string; prompt: string } | null {
  if (!id || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(id)) return null;
  const owned = matrixRecipes.find((recipe) => recipe.id === id);
  if (owned) return { id, prompt: owned.prompt };
  const inspiration = agentInspirations.find((recipe) => recipe.id === id);
  return inspiration ? { id, prompt: buildAgentRecipePrompt(inspiration) } : null;
}
