import { CanonicalChatOrchestrator } from "./orchestrator.js";
import { ChatAgentStore } from "./agent-store.js";
import { ChatAgentContext } from "./agent-context.js";
import type { ChatRepository } from "./repository.js";

export function chatAgentsEnabled(): boolean {
  return process.env.MATRIX_CHAT_AGENTS_ENABLED === "1";
}

/** Agent configuration shares the canonical database lock lifecycle; it owns no pool. */
export async function createCanonicalChatRuntime(options: Omit<ConstructorParameters<typeof CanonicalChatOrchestrator>[0], "agentContext"> & {
  repository: ChatRepository;
  homePath: string;
  enabled?: () => boolean;
}) {
  const agents = new ChatAgentStore({ homePath: options.homePath, db: options.repository.kysely });
  await agents.bootstrap();
  const context = new ChatAgentContext({
    repository: options.repository, agents, enabled: options.enabled ?? chatAgentsEnabled,
  });
  return { agents, context, orchestrator: new CanonicalChatOrchestrator({ ...options, agentContext: context }) };
}
