import { isDeepStrictEqual } from "node:util";
import { MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, MATRIX_CHATGPT_PLAN_INSTANCE_ID, chatgptPlanSelectionBinding,
  type CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { ChatGptPlanAuthority } from "../bots/chatgpt-plan.js";
import { BotRouteError, MANAGED_PI_INSTANCE_ID, resolveManagedPiRoute, type ResolvedBotRoute } from "../bots/route-resolver.js";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";

/** Normalize only the reviewed ordinary identity at this trusted gateway seam. */
export async function resolveManagedPiPlan(selection: CanonicalChatModelSelection, ownerId: string,
  authority?: Pick<ChatGptPlanAuthority, "resolve">): Promise<ResolvedBotRoute> {
  const selected = chatgptPlanSelectionBinding(selection.options);
  if (selection.instanceId !== MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID || !selected || !authority) throw new BotRouteError("model_unavailable");
  const resolved = await authority.resolve({ ...selection, instanceId: MATRIX_CHATGPT_PLAN_INSTANCE_ID }, ownerId, "interactive");
  if (resolved.accessSourceId !== MATRIX_CHATGPT_PLAN_INSTANCE_ID || resolved.route.api !== "openai-responses"
    || resolved.route.modelId !== selection.model || resolved.subscription?.accountId !== selected.accountId
    || String(resolved.subscription.grantRevision) !== selected.grantRevision) throw new BotRouteError("model_unavailable");
  return resolved;
}

export function sameManagedPiRoute(left: ResolvedBotRoute, right: ResolvedBotRoute): boolean {
  return left.accessSourceId === right.accessSourceId && isDeepStrictEqual(left.route, right.route)
    && isDeepStrictEqual(left.subscription, right.subscription);
}

export async function resolveManagedPiSelection(selection: CanonicalChatModelSelection, ownerId: string,
  deps: { providers: AiProviderSnapshotReader; chatgptPlan?: Pick<ChatGptPlanAuthority, "resolve"> }): Promise<ResolvedBotRoute> {
  if (selection.instanceId === MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID) return resolveManagedPiPlan(selection, ownerId, deps.chatgptPlan);
  if (selection.instanceId !== MANAGED_PI_INSTANCE_ID) throw new BotRouteError("model_unavailable");
  return resolveManagedPiRoute(await deps.providers.getSnapshot(), selection);
}
