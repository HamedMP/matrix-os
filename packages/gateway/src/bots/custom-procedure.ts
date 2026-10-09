import { isManagedCustomBot, isAutomaticBotSelection, chatgptPlanSelectionBinding, matrixAnthropicSelectionBinding, type ChatAgent, type BotEffect, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { ChatAgentStore } from "../chat/agent-store.js";
import type { ChatAgentRecipeResolver } from "../chat/agent-recipe.js";
import { recipeSkillPrompt } from "../chat/recipe-skill-context.js";
import { BotRouteError } from "./route-resolver.js";
import type { BotRecipeCatalog, BotRecipe } from "./recipe-catalog.js";
import type { BotExecutor } from "./repositories/shared.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import { sql } from "kysely";
import { MANAGED_CUSTOM_OPERATION_PREFIX } from "./custom-creation-authority.js";

/** A server-created definition is executable only with its active, owner-scoped creation operation. */
export function createBotProcedureResolver(deps: {
  db: BotExecutor; agents: Pick<ChatAgentStore, "get" | "matchesCreationHash">; recipes: BotRecipeCatalog; customRecipes: ChatAgentRecipeResolver;
}) {
  async function assert(ownerId: string, agent: ChatAgent, chatId?: string, revision?: number) {
    if (!isManagedCustomBot(agent) || agent.archived || revision !== undefined && agent.revision !== revision
      || agent.recipe?.skills.includes("matrix-jev-email-triage")) throw new BotRouteError("model_unavailable");
    const operation = await deps.db.selectFrom("bot_operations as operation")
      .innerJoin("bot_chat_bindings as binding", "binding.chat_id", "operation.chat_id")
      .innerJoin("chats as chat", "chat.id", "binding.chat_id")
      .select(["operation.chat_id", "operation.payload_hash"]).where("operation.owner_id", "=", ownerId).where("operation.bot_id", "=", agent.id)
      .where("operation.status", "=", "active").where(sql<boolean>`left(operation.client_request_id, ${MANAGED_CUSTOM_OPERATION_PREFIX.length}) = ${MANAGED_CUSTOM_OPERATION_PREFIX}`).where("binding.owner_id", "=", ownerId).where("binding.bot_id", "=", agent.id)
      .where("binding.kind", "=", "direct").where("binding.removed_at", "is", null)
      .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", ownerId)
      .where("chat.lifecycle", "=", "active").where("chat.collaboration", "is", null).executeTakeFirst();
    if (!operation || chatId !== undefined && operation.chat_id !== chatId
      || !await deps.agents.matchesCreationHash({ type: "personal", ownerId }, agent.id, operation.payload_hash)) throw new BotRouteError("model_unavailable");
  }
  return {
    assert,
    async resolve(ownerId: string, agent: ChatAgent): Promise<BotRecipe> {
      if (!isManagedCustomBot(agent)) {
        if (!agent.recipeRef) throw new BotRouteError("model_unavailable");
        return deps.recipes.resolve(agent.recipeRef);
      }
      await assert(ownerId, agent);
      const recipe = agent.recipe ? await deps.customRecipes.resolve(agent.recipe) : undefined;
      return { ...agent.recipeRef!, name: agent.name, description: agent.description,
        instructions: [agent.instructions, ...(recipe?.skills.map(recipeSkillPrompt) ?? [])].join("\n\n"),
        capabilities: ["artifact.read", "artifact.write", "interaction.create", "memory.propose", "memory.search",
          ...(recipe?.integrations.length ? ["integration.inventory", "integration.call"] as const : [])],
        // A declaration is only a ceiling. Existing grants and exact-action approvals still authorize every effect.
        integrations: (recipe?.integrations ?? []).map(item => ({ service: item.service, effects: ["read", "write", "send"] as readonly BotEffect[], required: false })),
        output: recipe?.output ?? "Answer the owner's request and distinguish confirmed work from unavailable actions." };
    },
    async revalidate(binding: BotRuntimeBinding): Promise<void> {
      if (binding.managedDefinitionRevision === undefined) return;
      const agent = await deps.agents.get({ type: "personal", ownerId: binding.ownerId }, binding.botId);
      if (!agent) throw new BotRouteError("model_unavailable");
      await assert(binding.ownerId, agent, binding.chatId, binding.managedDefinitionRevision);
      const selected = agent.selection;
      // Automatic was explicitly saved by the owner. Admission chooses only a
      // qualified funded/key source; a personal subscription never participates.
      if (isAutomaticBotSelection(selected)) {
        if (binding.subscription || binding.anthropicApi || !["matrix_included", "owner_anthropic_key"].includes(binding.accessSourceId)) throw new BotRouteError("model_unavailable");
        return;
      }
      if (selected.model !== binding.route.modelId) throw new BotRouteError("model_unavailable");
      if (selected.instanceId === "matrix_chatgpt_plan") {
        const source = chatgptPlanSelectionBinding(selected.options);
        if (binding.accessSourceId !== "matrix_chatgpt_plan" || !binding.subscription || binding.anthropicApi
          || !source || source.accountId !== binding.subscription.accountId
          || source.grantRevision !== String(binding.subscription.grantRevision)) throw new BotRouteError("model_unavailable");
      } else if (selected.instanceId === "matrix_anthropic_api") {
        const source = matrixAnthropicSelectionBinding(selected.options);
        if (binding.accessSourceId !== "owner_anthropic_key" || binding.subscription || !binding.anthropicApi
          || !source || source.connectionRevision !== binding.anthropicApi.connectionRevision
          || source.credentialGeneration !== binding.anthropicApi.credentialGeneration) throw new BotRouteError("model_unavailable");
      } else if (selected.instanceId !== "matrix_pi_default" || selected.options?.length
        || binding.accessSourceId !== "matrix_included" || binding.subscription || binding.anthropicApi) throw new BotRouteError("model_unavailable");
    },
  };
}

/** Custom coordinators never accept an unsaved source change from a turn request. */
export function sameCustomCoordinatorSelection(selected: CanonicalChatModelSelection | undefined, saved: CanonicalChatModelSelection): boolean {
  if (!selected || selected.instanceId === "matrix_bot_default" && selected.model === "auto" && !selected.options?.length) return true;
  const options = (value: CanonicalChatModelSelection) => [...(value.options ?? [])].sort((a,b) => a.id.localeCompare(b.id));
  return selected.model === saved.model && (selected.instanceId === saved.instanceId || selected.instanceId === "matrix_bot_default")
    && JSON.stringify(options(selected)) === JSON.stringify(options(saved));
}
