import { BotModelRouteSchema, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";
import type { ResolveCodexOwnerIdentity } from "../collaboration/codex-owner-identity.js";
import { CODEX_SUBSCRIPTION_URL } from "./codex-inference.js";
import { BotRouteError, resolveBotRoute, resolveManagedPiRoute, type ResolvedBotRoute } from "./route-resolver.js";

/** Trusted operator configuration chooses a concrete subscription model.
 * No renderer/provider picker may set it. A configured subscription never
 * silently falls back to Matrix credit or another owner's provider.
 */
export function createBotModelRouteResolver(options: {
  codexModel?: string;
  providers: AiProviderSnapshotReader;
  resolveCodexIdentity: ResolveCodexOwnerIdentity;
  lifetime: AbortSignal;
}): (selection?: CanonicalChatModelSelection) => Promise<ResolvedBotRoute> {
  return async (selection) => {
    if (selection) return resolveManagedPiRoute(await options.providers.getSnapshot(), selection);
    if (options.codexModel === undefined) return resolveBotRoute(await options.providers.getSnapshot());
    const route = BotModelRouteSchema.safeParse({ api: "openai-responses", modelId: options.codexModel,
      input: ["text", "image"], contextWindow: 128_000, maxOutputTokens: 8_192 });
    if (!route.success || !options.codexModel.startsWith("gpt-")) throw new BotRouteError("model_unavailable");
    try {
      const identity = await options.resolveCodexIdentity(AbortSignal.any([options.lifetime, AbortSignal.timeout(30_000)]));
      if (identity.url !== CODEX_SUBSCRIPTION_URL) throw new BotRouteError("model_unavailable");
    } catch (error: unknown) {
      console.warn("[bots] Codex subscription identity unavailable:", error instanceof Error ? error.name : "UnknownError");
      throw new BotRouteError("model_unavailable");
    }
    return { route: route.data, accessSourceId: "owner_openai_profile" };
  };
}
