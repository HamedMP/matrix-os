import { CreateChatAgentRequestSchema } from "#chat-agents";
import { chatgptPlanSelectionBinding, MATRIX_CHATGPT_PLAN_INSTANCE_ID, MATRIX_PI_CHAT_INSTANCE_ID } from "#bots/model-choice";
import type { ChatAgent } from "#chat-agents";
import { z } from "zod/v4";

/** Reserved server-owned coordinator identity. Generic Agent mutations cannot set recipeRef. */
export const MANAGED_CUSTOM_BOT_RECIPE_REF = { recipeId: "custom-coordinator", version: "1" } as const;
export function isManagedCustomBot(agent: Pick<ChatAgent, "recipeRef">): boolean {
  return agent.recipeRef?.recipeId === MANAGED_CUSTOM_BOT_RECIPE_REF.recipeId && agent.recipeRef.version === MANAGED_CUSTOM_BOT_RECIPE_REF.version;
}
// Funded models carry no client source overrides; the gateway checks current
// funded readiness. Personal subscriptions retain their exact account/grant.
export const CreateManagedCustomBotRequestSchema = CreateChatAgentRequestSchema.refine(input =>
  ((input.selection.instanceId === MATRIX_PI_CHAT_INSTANCE_ID && !input.selection.options?.length)
    || (input.selection.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID && Boolean(chatgptPlanSelectionBinding(input.selection.options))))
  && !input.recipe?.skills.includes("matrix-jev-email-triage"), { message: "Choose a supported Bot model and recipe" });
export type CreateManagedCustomBotRequest = import("zod/v4").infer<typeof CreateManagedCustomBotRequestSchema>;
export const RecoverManagedCustomBotRequestSchema = z.object({
  baseRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type RecoverManagedCustomBotRequest = z.infer<typeof RecoverManagedCustomBotRequestSchema>;
