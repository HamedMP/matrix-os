import { isDeepStrictEqual } from "node:util";
import { MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, MATRIX_CHATGPT_PLAN_INSTANCE_ID, MATRIX_PI_ANTHROPIC_API_INSTANCE_ID, matrixAnthropicSelectionBinding, chatgptPlanSelectionBinding,
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
    && isDeepStrictEqual(left.subscription, right.subscription) && isDeepStrictEqual(left.anthropicApi, right.anthropicApi);
}

export async function resolveManagedPiAnthropic(selection: CanonicalChatModelSelection, ownerId: string,
  authority?: Pick<import("../bots/matrix-anthropic-api.js").MatrixAnthropicAuthority, "resolve">): Promise<ResolvedBotRoute> {
  const selected = matrixAnthropicSelectionBinding(selection.options);
  if (selection.instanceId !== MATRIX_PI_ANTHROPIC_API_INSTANCE_ID || !selected || !authority) throw new BotRouteError("model_unavailable");
  const resolved = await authority.resolve(selection, ownerId, "interactive");
  if (resolved.accessSourceId !== "owner_anthropic_key" || resolved.route.api !== "anthropic-messages" || resolved.subscription
    || resolved.route.modelId !== selection.model || !isDeepStrictEqual(resolved.anthropicApi, selected)) throw new BotRouteError("model_unavailable");
  return resolved;
}

export async function resolveManagedPiSelection(selection: CanonicalChatModelSelection, ownerId: string,
  deps: { providers: AiProviderSnapshotReader; chatgptPlan?: Pick<ChatGptPlanAuthority, "resolve">; matrixAnthropic?: Pick<import("../bots/matrix-anthropic-api.js").MatrixAnthropicAuthority, "resolve"> }): Promise<ResolvedBotRoute> {
  if (selection.instanceId === MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID) return resolveManagedPiPlan(selection, ownerId, deps.chatgptPlan);
  if (selection.instanceId === MATRIX_PI_ANTHROPIC_API_INSTANCE_ID) return resolveManagedPiAnthropic(selection, ownerId, deps.matrixAnthropic);
  if (selection.instanceId !== MANAGED_PI_INSTANCE_ID) throw new BotRouteError("model_unavailable");
  return resolveManagedPiRoute(await deps.providers.getSnapshot(), selection);
}
