import { MATRIX_BOT_SELECTION, MATRIX_CHATGPT_PLAN_INSTANCE_ID, MATRIX_ANTHROPIC_API_INSTANCE_ID, MATRIX_PI_CHAT_INSTANCE_ID, chatgptPlanSelectionBinding, matrixAnthropicSelectionBinding, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { BotRouteError } from "./route-resolver.js";
/** Recipe projection may rename a qualified coordinator, but never discard its payment binding. */
export function recipeCoordinatorSelection(input: CanonicalChatModelSelection | undefined, saved: CanonicalChatModelSelection): CanonicalChatModelSelection | undefined {
  const selected = input && input.model !== "auto" ? input : saved;
  if (selected.instanceId === MATRIX_BOT_SELECTION.instanceId && selected.model === MATRIX_BOT_SELECTION.model && !selected.options?.length) return undefined;
  if (selected.instanceId === MATRIX_ANTHROPIC_API_INSTANCE_ID || selected.instanceId === MATRIX_BOT_SELECTION.instanceId && matrixAnthropicSelectionBinding(selected.options)) {
    if (!matrixAnthropicSelectionBinding(selected.options)) throw new BotRouteError("model_unavailable");
    return { ...selected, instanceId: MATRIX_ANTHROPIC_API_INSTANCE_ID };
  }
  if (selected.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID || selected.instanceId === MATRIX_BOT_SELECTION.instanceId && chatgptPlanSelectionBinding(selected.options)) {
    if (!chatgptPlanSelectionBinding(selected.options)) throw new BotRouteError("model_unavailable");
    return { ...selected, instanceId: MATRIX_CHATGPT_PLAN_INSTANCE_ID };
  }
  if ((selected.instanceId === MATRIX_PI_CHAT_INSTANCE_ID || selected.instanceId === MATRIX_BOT_SELECTION.instanceId) && !selected.options?.length) return { ...selected, instanceId: MATRIX_PI_CHAT_INSTANCE_ID };
  if (!input || input.model === "auto") return undefined;
  throw new BotRouteError("model_unavailable");
}
