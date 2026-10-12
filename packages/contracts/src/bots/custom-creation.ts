import { CreateChatAgentRequestSchema } from "#chat-agents";
import { chatgptPlanSelectionBinding, MATRIX_CHATGPT_PLAN_INSTANCE_ID } from "#bots/model-choice";
import type { ChatAgent } from "#chat-agents";

/** Reserved server-owned coordinator identity. Generic Agent mutations cannot set recipeRef. */
export const MANAGED_CUSTOM_BOT_RECIPE_REF = { recipeId: "custom-coordinator", version: "1" } as const;
export function isManagedCustomBot(agent: Pick<ChatAgent, "recipeRef">): boolean {
  return agent.recipeRef?.recipeId === MANAGED_CUSTOM_BOT_RECIPE_REF.recipeId && agent.recipeRef.version === MANAGED_CUSTOM_BOT_RECIPE_REF.version;
}
export const CreateManagedCustomBotRequestSchema = CreateChatAgentRequestSchema.refine(input =>
  input.selection.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID && Boolean(chatgptPlanSelectionBinding(input.selection.options))
  && !input.recipe?.skills.includes("matrix-jev-email-triage"), { message: "Choose a qualified Bot subscription" });
export type CreateManagedCustomBotRequest = import("zod/v4").infer<typeof CreateManagedCustomBotRequestSchema>;
