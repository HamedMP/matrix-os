import { MANAGED_CUSTOM_BOT_RECIPE_REF, type ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentRecipeResolver } from "../chat/agent-recipe.js";
import { recipeSkillPrompt } from "../chat/recipe-skill-context.js";
import type { BotRecipe } from "./recipe-catalog.js";
import { BotSystemPromptError, buildBotSystemPrompt } from "./system-prompt.js";

export class ManagedCustomDefinitionError extends Error {
  constructor(readonly code: "unsupported_skill" | "prompt_too_large") {
    super(code);
    this.name = "ManagedCustomDefinitionError";
  }
}

type Definition = Pick<ChatAgent, "name" | "description" | "instructions" | "recipe">;

/** Shared save/run composition. Skill text and declarations never grant access. */
export async function composeManagedCustomDefinition(
  definition: Definition,
  recipes?: Pick<ChatAgentRecipeResolver, "resolve">,
): Promise<BotRecipe> {
  // This skill uses the separate legacy Hermes workflow, not this coordinator.
  // Reject before resolving or binding a Gmail account.
  if (definition.recipe?.skills.includes("matrix-jev-email-triage")) throw new ManagedCustomDefinitionError("unsupported_skill");
  if (definition.recipe && !recipes) throw new Error("Custom recipe resolver unavailable");
  const recipe = definition.recipe ? await recipes!.resolve(definition.recipe) : undefined;
  const integrationIntent = recipe?.integrations.length ? [
    "Selected integration dependencies:",
    ...recipe.integrations.map(({ service, accountLabel }) =>
      `- ${service} (${accountLabel ? `account ${JSON.stringify(accountLabel)}` : "account not specified"})`),
    "Account labels express the owner's intent and do not grant access. Use current account inventory and authorization; ask when the selected account is unavailable or ambiguous.",
  ].join("\n") : undefined;
  const procedure: BotRecipe = {
    ...MANAGED_CUSTOM_BOT_RECIPE_REF,
    name: definition.name,
    description: definition.description,
    instructions: [definition.instructions, ...(recipe?.skills.map(recipeSkillPrompt) ?? []),
      ...(integrationIntent ? [integrationIntent] : [])].join("\n\n"),
    capabilities: ["artifact.read", "artifact.write", "interaction.create", "memory.propose", "memory.search",
      ...(recipe?.integrations.length ? ["integration.inventory", "integration.call"] as const : [])],
    // The current grants and exact-action approvals still authorize each effect.
    integrations: (recipe?.integrations ?? []).map(item => ({ service: item.service, effects: ["read", "write", "send"], required: false })),
    output: recipe?.output ?? "Answer the owner's request and distinguish confirmed work from unavailable actions.",
  };
  return procedure;
}

/** Save-time admission; runtime checks the same prompt after creating its task. */
export async function resolveManagedCustomDefinition(
  definition: Definition,
  recipes?: Pick<ChatAgentRecipeResolver, "resolve">,
): Promise<BotRecipe> {
  const procedure = await composeManagedCustomDefinition(definition, recipes);
  try {
    // The timestamp has the same ISO width as runtime. Optional confirmed memory
    // retains the runtime's existing priority-based trimming; never trim the job.
    buildBotSystemPrompt({ botName: procedure.name, instructions: procedure.instructions, recipe: procedure, now: new Date("2000-01-01T00:00:00.000Z") });
  } catch (error) {
    if (error instanceof BotSystemPromptError) throw new ManagedCustomDefinitionError("prompt_too_large");
    throw error;
  }
  return procedure;
}
