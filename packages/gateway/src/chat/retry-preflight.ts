import type { CanonicalOwnerScope } from "@matrix-os/contracts";
import { boundedOperation } from "../bounded-operation.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";

/** Read-only preflight. Admission remains transactionally guarded by the repository. */
export async function retryAvailability(
  adapter: CanonicalChatProviderAdapter,
  owner: CanonicalOwnerScope,
  state: unknown,
  loadPreviousAttempt: () => Promise<{ schemaVersion: number; state: unknown } | null>,
  isReplay?: () => Promise<boolean>,
): Promise<"ready" | "busy" | "unavailable"> {
  if (!adapter.isBackingRunActive) return "ready";
  try {
    return await boundedOperation(async (signal) => {
      if (await isReplay?.()) return "ready";
      // Resume history only selects completed Runs; the failed attempt's
      // backing identity must be checked separately, even on a fresh Chat.
      const previous = await loadPreviousAttempt();
      if (previous && previous.schemaVersion !== adapter.stateSchemaVersion) return "unavailable";
      const previousState = previous ? adapter.parseState(previous.state) : undefined;
      for (const candidate of [previousState, state]) {
        signal.throwIfAborted();
        if (candidate !== undefined && await adapter.isBackingRunActive!({ owner, state: candidate, signal })) return "busy";
      }
      return "ready";
    }, 10_000);
  } catch (error) {
    console.warn("[chat] Retry backing state unavailable:", error instanceof Error ? error.name : "UnknownError");
    return "unavailable";
  }
}
