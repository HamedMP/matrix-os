import { CanonicalChatNavigationQuerySchema, type CanonicalChatNavigationQuery,
  type CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import type { ChatOwner } from "./records.js";
import type { ChatNavigationReader } from "./navigation-repository.js";

/** Fast persisted projection; authenticated event replay owns lifecycle recovery. */
export function createChatNavigationService(options: {
  navigation?: ChatNavigationReader;
}): (owner: ChatOwner, input: CanonicalChatNavigationQuery) => Promise<CanonicalChatNavigationResponse> {
  return async (owner, input) => {
    const query = CanonicalChatNavigationQuerySchema.parse(input);
    if (!options.navigation) throw new Error("Navigation is unavailable");
    const started = performance.now();
    let snapshot: CanonicalChatNavigationResponse;
    try {
      snapshot = await options.navigation.list(owner, query);
    } catch (error: unknown) {
      console.error("[chat/navigation] Projection failed:", error instanceof Error ? error.name : "UnknownError");
      // Invalid stored projections/oversize output are service failures, not invalid client queries.
      throw new Error("Navigation is unavailable");
    }
    console.info("[chat/navigation] Projection", {
      durationMs: Math.round(performance.now() - started), items: snapshot.items.length, queries: 1,
      truncated: snapshot.truncated,
    });
    return snapshot;
  };
}
