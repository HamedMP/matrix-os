import { z } from "zod/v4";
import { CreateChatAgentRequestSchema, ChatAgentInputFieldsSchema } from "#chat-agents";
import { BotRecipeRefSchema } from "#bots/bot";
import { chatgptPlanSelectionBinding, matrixAnthropicSelectionBinding, isAutomaticBotSelection, MATRIX_CHATGPT_PLAN_INSTANCE_ID } from "#bots/model-choice";
import type { ChatAgent } from "#chat-agents";

/** Reserved server-owned coordinator identity. Generic Agent mutations cannot set recipeRef. */
export const MANAGED_CUSTOM_BOT_RECIPE_REF = { recipeId: "custom-coordinator", version: "1" } as const;
export function isManagedCustomBot(agent: Pick<ChatAgent, "recipeRef">): boolean {
  return agent.recipeRef?.recipeId === MANAGED_CUSTOM_BOT_RECIPE_REF.recipeId && agent.recipeRef.version === MANAGED_CUSTOM_BOT_RECIPE_REF.version;
}
/** Read-only writable seed. Server capabilities, effects and identity policy never become draft authority. */
export const BotCreationSeedResponseSchema = z.object({
  recipe: BotRecipeRefSchema,
  editable: z.boolean(),
  draft: ChatAgentInputFieldsSchema.omit({ selection: true }),
}).strict();
export type BotCreationSeedResponse = z.infer<typeof BotCreationSeedResponseSchema>;

export const CreateManagedCustomBotRequestSchema = CreateChatAgentRequestSchema.extend({
  seedRecipe: BotRecipeRefSchema.optional(),
}).strict().refine(input => {
  const selected = input.selection;
  const qualified = selected.instanceId === "matrix_pi_default" && !selected.options?.length
    || isAutomaticBotSelection(selected)
    || selected.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID && Boolean(chatgptPlanSelectionBinding(selected.options))
    || selected.instanceId === "matrix_anthropic_api" && Boolean(matrixAnthropicSelectionBinding(selected.options));
  return qualified && !input.recipe?.skills.includes("matrix-jev-email-triage");
}, { message: "Choose a qualified Bot connection" });
export type CreateManagedCustomBotRequest = import("zod/v4").infer<typeof CreateManagedCustomBotRequestSchema>;
