import type { CodingAgentProviderAdapter } from "./provider-adapter.js";
import type { CodingAgentTurnStore } from "./thread-store.js";

type TurnLifecycleStore = Pick<
  CodingAgentTurnStore,
  "recoverActiveTurns" | "shutdownTurns"
>;

export async function createCodingAgentTurnLifecycle(options: {
  store?: TurnLifecycleStore;
  providers: ReadonlyArray<Pick<CodingAgentProviderAdapter, "resumeTurn">>;
  logFailure(scope: string, err: unknown): void;
}): Promise<{
  turnsEnabled: boolean;
  shutdown(): Promise<void>;
}> {
  let recoveryReady = false;
  if (options.store) {
    try {
      await options.store.recoverActiveTurns();
      recoveryReady = true;
    } catch (err: unknown) {
      options.logFailure("Failed to reconcile active turns", err);
    }
  }

  return {
    turnsEnabled: recoveryReady &&
      options.providers.length > 0 &&
      options.providers.every((provider) => Boolean(provider.resumeTurn)),
    async shutdown() {
      try {
        await options.store?.shutdownTurns();
      } catch (err: unknown) {
        options.logFailure("Turn shutdown failed", err);
      }
    },
  };
}
