import { CanonicalChatOrchestrator } from "./orchestrator.js";
import { ChatAgentStore } from "./agent-store.js";
import { ChatAgentContext } from "./agent-context.js";
import { createChatAgentRecipeResolver, discoverChatAgentRecipeSkillsRoot } from "./agent-recipe.js";
import { listServices } from "../integrations/registry.js";
import type { ChatRepository } from "./repository.js";

export function chatAgentsEnabled(): boolean {
  return process.env.MATRIX_CHAT_AGENTS_ENABLED === "1";
}

/** Agent configuration shares the canonical database lock lifecycle; it owns no pool. */
export async function createCanonicalChatRuntime(options: Omit<ConstructorParameters<typeof CanonicalChatOrchestrator>[0], "agentContext"> & {
  repository: ChatRepository;
  homePath: string;
  recipeSkillsRoot?: string;
  enabled?: () => boolean;
}) {
  const recipes = createChatAgentRecipeResolver({
    skillsRoot: await discoverChatAgentRecipeSkillsRoot({ skillsRoot: options.recipeSkillsRoot }),
    homePath: options.homePath,
    services: listServices().map(({ id, name }) => ({ id, name })),
  });
  const agents = new ChatAgentStore({ homePath: options.homePath, db: options.repository.kysely });
  await agents.bootstrap();
  const context = new ChatAgentContext({
    repository: options.repository, agents, recipes, enabled: options.enabled ?? chatAgentsEnabled,
  });
  return { agents, recipes, context, orchestrator: new CanonicalChatOrchestrator({ ...options, agentContext: context }) };
}
