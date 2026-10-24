import type { AiProviderHealthProbe } from "./service.js";
import { readOwnerOpenRouterKey } from "./owner-openrouter-key.js";

/** Bounded non-billable key readiness probe. Upstream content is never consumed. */
export function createOwnerOpenRouterKeyPreflight(options: { homePath: string; fetchFn?: typeof fetch; now?: () => number }): AiProviderHealthProbe {
  const now = options.now ?? Date.now;
  return async (sourceId, parent) => {
    if (sourceId !== "owner_openrouter") return null;
    const initial = await readOwnerOpenRouterKey(options.homePath);
    if (!initial.key || !initial.credentialGeneration) return null;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
    try {
      const response = await (options.fetchFn ?? fetch)("https://openrouter.ai/api/v1/key", {
        redirect: "error", signal, headers: { Authorization: `Bearer ${initial.key}` },
      });
      await response.body?.cancel();
      if (response.status !== 200) return null;
      const current = await readOwnerOpenRouterKey(options.homePath);
      signal.throwIfAborted();
      if (current.credentialGeneration !== initial.credentialGeneration || current.key !== initial.key) return null;
      const checked = now();
      return { state: "ready", checkedAt: new Date(checked).toISOString(), staleAfter: new Date(checked + 30_000).toISOString(), action: "none", safeReason: null };
    } catch (error) {
      parent.throwIfAborted();
      console.warn("[ai-providers] OpenRouter auth health unavailable", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  };
}

