import { agentInspirations, type AgentInspiration } from "./agent-inspirations.generated.js";
import { matrixRecipes } from "./matrix-recipes.generated.js";

export function buildAgentRecipePrompt(recipe: AgentInspiration) {
  const capabilities = recipe.skills.slice(0, 5).join(", ");
  const integrations = recipe.integrations.slice(0, 5).join(", ");
  return `Help me create a Matrix agent inspired by “${recipe.name}”. ${recipe.description} Start by asking me the few decisions needed to tailor it. Suggested capabilities: ${capabilities || "none listed"}. Possible integrations: ${integrations || "none listed"}. Do not copy third-party private prompts; build an original agent for my needs.`;
}

export function resolveRecipeHandoff(id: string | null): { id: string; prompt: string } | null {
  if (!id || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(id)) return null;
  const owned = matrixRecipes.find((recipe) => recipe.id === id);
  if (owned) return { id, prompt: owned.prompt };
  const inspiration = agentInspirations.find((recipe) => recipe.id === id);
  return inspiration ? { id, prompt: buildAgentRecipePrompt(inspiration) } : null;
}
