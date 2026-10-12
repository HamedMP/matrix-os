import { isAutomaticBotSelection, type AiProviderSnapshotV3, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { BotInstantiationError } from "./instantiation.js";
import { resolveManagedPiRoute } from "./route-resolver.js";

/** Creation records intent; exact Automatic is admitted without running or borrowing a source. */
export function createBotCreationSelectionValidator(deps: {
  available(): boolean;
  providers: { getSnapshot(): Promise<AiProviderSnapshotV3> };
  matrixAnthropic?: { resolve(selection: CanonicalChatModelSelection, ownerId: string, requestClass: "interactive"): Promise<unknown> };
  chatgptPlan?: { resolve(selection: CanonicalChatModelSelection, ownerId: string, requestClass: "interactive"): Promise<unknown> };
}) {
  return async (ownerId: string, selection: CanonicalChatModelSelection): Promise<void> => {
    if (!deps.available()) throw new BotInstantiationError("unavailable");
    if (isAutomaticBotSelection(selection)) return;
    try {
      if (selection.instanceId === "matrix_anthropic_api" && deps.matrixAnthropic) await deps.matrixAnthropic.resolve(selection, ownerId, "interactive");
      else if (selection.instanceId === "matrix_chatgpt_plan" && deps.chatgptPlan) await deps.chatgptPlan.resolve(selection, ownerId, "interactive");
      else resolveManagedPiRoute(await deps.providers.getSnapshot(), selection);
    } catch (error: unknown) {
      console.warn("[bots] selected managed model unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new BotInstantiationError("invalid_request");
    }
  };
}
