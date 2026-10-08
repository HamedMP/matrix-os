import type { BotProviderConnectionsService } from './provider-connections.js';

/** Determines whether a run may advertise the optional native task tool. */
export function createBotExecutorReadiness(deps: {
  runtimeOwnerId?: string | null;
  computerId?: string | null;
  nativeTasks: boolean;
  connections: Pick<BotProviderConnectionsService, 'execution' | 'admit'>;
}) {
  return async (ownerId: string, botId: string): Promise<boolean> => {
    // Shared-runtime access never grants the host owner's native credentials.
    // Coordinator tools have their own binding/grant admission and can still run.
    if (!deps.runtimeOwnerId || !deps.computerId || ownerId !== deps.runtimeOwnerId) return false;
    const selected = await deps.connections.execution(ownerId, botId);
    if (!selected.connectionId) return false;
    await deps.connections.admit(ownerId, botId, 'interactive');
    return deps.nativeTasks;
  };
}
