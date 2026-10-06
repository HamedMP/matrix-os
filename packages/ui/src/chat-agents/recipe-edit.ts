import type { ChatAgent, ChatAgentRecipe } from "@matrix-os/contracts";

/** Editable fields exclude broker-stamped authority; unchanged edits must not rebind it. */
export function editableAgentRecipe(agent: ChatAgent): ChatAgentRecipe | undefined {
  const recipe = agent.recipe;
  return recipe ? { skills: [...recipe.skills], integrations: recipe.integrations.map(item => ({ ...item })), output: recipe.output,
    ...(recipe.jevInboxLabeling !== undefined ? { jevInboxLabeling: recipe.jevInboxLabeling } : {}) } : undefined;
}

export function agentRecipePatch(agent: ChatAgent, draft: ChatAgentRecipe | null | undefined): { recipe?: ChatAgentRecipe | null } {
  return agent.recipeRef || draft === undefined || JSON.stringify(draft) === JSON.stringify(editableAgentRecipe(agent)) ? {} : { recipe: draft };
}
