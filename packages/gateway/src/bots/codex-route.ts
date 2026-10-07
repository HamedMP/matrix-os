import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";
import type { ResolveCodexOwnerIdentity } from "../collaboration/codex-owner-identity.js";
import { BotRouteError, resolveBotRoute, resolveManagedPiRoute, type ResolvedBotRoute } from "./route-resolver.js";

/** Legacy operator subscription pins remain fail-closed until Matrix owns an approved SIWC route.
 * A concrete managed selection is a distinct explicit route, never an implicit funding fallback.
 */
export function createBotModelRouteResolver(options: {
  codexModel?: string;
  chatgptPlan?: import("./chatgpt-plan.js").ChatGptPlanAuthority;
  ownerId?: string;
  providers: AiProviderSnapshotReader;
  /** Compatibility only; native Codex identity must never fund a Pi coordinator. */
  resolveCodexIdentity?: ResolveCodexOwnerIdentity;
  lifetime?: AbortSignal;
}): (selection?: CanonicalChatModelSelection) => Promise<ResolvedBotRoute> {
  return async (selection) => {
    if (selection?.instanceId === "matrix_chatgpt_plan") {
      if (!options.chatgptPlan || !options.ownerId) throw new BotRouteError("model_unavailable");
      return options.chatgptPlan.resolve(selection, options.ownerId, "interactive");
    }
    if (selection) return resolveManagedPiRoute(await options.providers.getSnapshot(), selection);
    if (options.codexModel !== undefined) throw new BotRouteError("model_unavailable");
    return resolveBotRoute(await options.providers.getSnapshot());
  };
}
