import type { CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor } from "#canonical-chat-provider";
import type { CanonicalChatModelSelection } from "#canonical-chat";
import { MATRIX_BOT_SELECTION } from "#bots/selection";
import { MatrixAnthropicCredentialGenerationSchema } from "#matrix-anthropic-connection";

export const MATRIX_PI_CHAT_INSTANCE_ID = "matrix_pi_default";
export const MATRIX_CHATGPT_PLAN_INSTANCE_ID = "matrix_chatgpt_plan";
/** Ordinary private Chat uses its own Pi admission, never the recipe-only Bot route. */
export const MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID = "matrix_pi_chatgpt_plan";
export const MATRIX_PI_ANTHROPIC_API_INSTANCE_ID = "matrix_pi_anthropic_api";
export const MATRIX_ANTHROPIC_API_INSTANCE_ID = "matrix_anthropic_api";
export function isMatrixAnthropicChatRoute(route: { instanceId: string; driverKind: string }): boolean {
  return route.instanceId === MATRIX_PI_ANTHROPIC_API_INSTANCE_ID && route.driverKind === "matrix_pi";
}
export function isMatrixAnthropicBotRoute(route: { instanceId: string; driverKind: string }): boolean {
  return route.instanceId === MATRIX_ANTHROPIC_API_INSTANCE_ID && route.driverKind === "matrix_bot";
}
export interface MatrixAnthropicBinding { connectionRevision: number; credentialGeneration: string }
export function matrixAnthropicSelectionBinding(options?: CanonicalChatModelSelection["options"]): MatrixAnthropicBinding | null {
  if (options?.length !== 2) return null;
  const revision = options.find(option => option.id === "connectionRevision")?.value;
  const generation = options.find(option => option.id === "credentialGeneration")?.value;
  if (typeof revision !== "string" || !/^[1-9][0-9]{0,15}$/.test(revision) || !Number.isSafeInteger(Number(revision))) return null;
  const parsed = MatrixAnthropicCredentialGenerationSchema.safeParse(generation);
  return parsed.success ? { connectionRevision: Number(revision), credentialGeneration: parsed.data } : null;
}
export function sameMatrixAnthropicSelectionBinding(left?: CanonicalChatModelSelection["options"], right?: CanonicalChatModelSelection["options"]): boolean {
  const a = matrixAnthropicSelectionBinding(left), b = matrixAnthropicSelectionBinding(right);
  return !!a && !!b && a.connectionRevision === b.connectionRevision && a.credentialGeneration === b.credentialGeneration;
}
export function isChatgptPlanChatRoute(route: { instanceId: string; driverKind: string }): boolean {
  return route.instanceId === MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID && route.driverKind === "matrix_pi";
}

export function isChatgptPlanBotRoute(route: { instanceId: string; driverKind: string }): boolean {
  return route.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID && route.driverKind === "matrix_bot";
}

export function isPiBotCoordinatorRoute(route: { instanceId: string; driverKind: string }): boolean {
  return isManagedPiBotRoute(route) || isChatgptPlanBotRoute(route) || isMatrixAnthropicBotRoute(route);
}

/** Nonsecret source binding must survive account switches and grant revocation. */
export function chatgptPlanSelectionBinding(options?: CanonicalChatModelSelection["options"]): { accountId: string; grantRevision: string } | null {
  if (options?.length !== 2) return null;
  const accountId = options.find(option => option.id === "accountId")?.value;
  const grantRevision = options.find(option => option.id === "grantRevision")?.value;
  return typeof accountId === "string" && accountId.length > 0 && accountId.length <= 160
    && typeof grantRevision === "string" && /^(0|[1-9][0-9]{0,15})$/.test(grantRevision)
    && Number.isSafeInteger(Number(grantRevision)) ? { accountId, grantRevision } : null;
}

export function sameChatgptPlanSelectionBinding(left?: CanonicalChatModelSelection["options"], right?: CanonicalChatModelSelection["options"]): boolean {
  const a = chatgptPlanSelectionBinding(left), b = chatgptPlanSelectionBinding(right);
  return !!a && !!b && a.accountId === b.accountId && a.grantRevision === b.grantRevision;
}

export function isManagedPiBotRoute(route: { instanceId: string; driverKind: string; connectionLabel?: string }): boolean {
  // Connection labels are optional negotiated presentation, not route identity.
  return route.instanceId === MATRIX_PI_CHAT_INSTANCE_ID && route.driverKind === "matrix_pi";
}

/** Retired Matrix SDK identities remain readable, never a current executable choice. */
export function isLegacyMatrixSdkProvider(instance: { id: string; driverKind: string }): boolean {
  return instance.id === "kernel_matrix_included" && instance.driverKind === "kernel";
}

/** Discovery reflects the authenticated catalog; it never acquires credentials or admits a run. */
export function managedPiBotModelChoices(catalog?: CanonicalProviderCatalog | null): Array<{ label: string; selection: CanonicalChatModelSelection }> {
  return catalog?.instances.flatMap((instance) => isManagedPiBotRoute({ instanceId: instance.id, ...instance })
    && instance.availability === "available"
    ? instance.models.flatMap((model) => model.availability === "available"
      ? [{ label: `${model.displayName} · Matrix AI`, selection: { instanceId: instance.id, model: model.id } }] : []) : []) ?? [];
}

/** Only the supported legacy sentinel denotes configured Automatic routing. */
export function isAutomaticBotSelection(selection: CanonicalChatModelSelection | null | undefined): boolean {
  return Boolean(selection && selection.instanceId === MATRIX_BOT_SELECTION.instanceId && selection.model === MATRIX_BOT_SELECTION.model
    && !selection.options?.length);
}

export function botModelRoutingLabel(selection: CanonicalChatModelSelection | null | undefined,
  catalog?: CanonicalProviderCatalog | null): string {
  if (selection === undefined) return "Checking bot model…";
  if (!selection) return "Bot model unavailable";
  if (isAutomaticBotSelection(selection)) return "Model routing: automatic";
  const instance = catalog?.instances.find((candidate) => candidate.id === selection.instanceId);
  const model = instance?.models.find((candidate) => candidate.id === selection.model);
  if (selection.instanceId === MATRIX_ANTHROPIC_API_INSTANCE_ID) {
    const unavailable = !instance || instance.availability !== "available" || model?.availability !== "available"
      || !isMatrixAnthropicBotRoute({ instanceId: instance.id, driverKind: instance.driverKind })
      || !sameMatrixAnthropicSelectionBinding(selection.options, instance.defaultSelection?.options);
    return `Anthropic API · ${model?.displayName ?? selection.model}${unavailable ? " · unavailable" : ""}`;
  }
  if (selection.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID) {
    const unavailable = !instance || instance.availability !== "available" || model?.availability !== "available"
      || !isChatgptPlanBotRoute({ instanceId: instance.id, driverKind: instance.driverKind })
      || !sameChatgptPlanSelectionBinding(selection.options, instance.defaultSelection?.options);
    return `ChatGPT subscription · ${model?.displayName ?? selection.model}${unavailable ? " · unavailable" : ""}`;
  }
  if (selection.instanceId !== MATRIX_PI_CHAT_INSTANCE_ID) {
    return `${canonicalProviderModelRouteLabel(instance, model?.displayName ?? selection.model)} · unavailable`;
  }
  const unavailable = catalog && (instance?.availability !== "available" || model?.availability !== "available"
    || !isManagedPiBotRoute({ instanceId: instance.id, driverKind: instance.driverKind }));
  const status = instance && model && canonicalProviderFundingState(instance) === "credit_reserved" ? "credit reserved" : "unavailable";
  return `Matrix AI · ${model?.displayName ?? selection.model}${unavailable ? ` · ${status}` : ""}`;
}

const UNAVAILABLE_LABELS: Record<
  NonNullable<CanonicalProviderInstanceDescriptor["unavailabilityReason"]>,
  string
> = {
  disabled_in_settings: "Disabled in Settings",
  settings_unavailable: "Settings unavailable",
  runtime_not_runnable: "Not supported in this runtime",
  runtime_inactive: "Runtime inactive",
  runtime_unavailable: "Runtime unavailable",
  not_installed: "Not installed",
  authentication_required: "Authentication required",
  multiple_profiles_unsupported: "Choose one enabled account",
};

/** Settings disablement keeps presentation priority over any funding observation. */
export function canonicalProviderFundingState(
  instance: CanonicalProviderInstanceDescriptor,
): CanonicalProviderInstanceDescriptor["connectionState"] {
  return instance.unavailabilityReason === "disabled_in_settings" || instance.unavailabilityReason === "settings_unavailable"
    ? undefined : instance.connectionState;
}

export function canonicalProviderAvailabilityReasonLabel(
  instance: CanonicalProviderInstanceDescriptor,
): string {
  const fundingState = canonicalProviderFundingState(instance);
  if (fundingState === "credit_required") return "Matrix AI credit required";
  if (fundingState === "credit_reserved") return "Matrix AI credit reserved";
  if (fundingState === "budget_exceeded") return "Monthly AI budget reached";
  if (fundingState === "unavailable") return "Matrix AI unavailable";
  if (instance.availability === "available") return "Available";
  if (instance.unavailabilityReason) return UNAVAILABLE_LABELS[instance.unavailabilityReason];
  if (instance.availability === "setup_required") return "Setup required";
  if (instance.availability === "auth_required") return "Authentication required";
  return "Unavailable";
}
/** Keep equally named models distinguishable using server-projected route labels. */
export function canonicalProviderModelRouteLabel(instance: CanonicalProviderInstanceDescriptor | undefined,
  modelLabel: string): string {
  if (!instance) return modelLabel;
  if (isMatrixAnthropicChatRoute({ instanceId: instance.id, driverKind: instance.driverKind })
    || isMatrixAnthropicBotRoute({ instanceId: instance.id, driverKind: instance.driverKind })) return `${modelLabel} · Matrix AI · Anthropic API`;
  if (isChatgptPlanChatRoute({ instanceId: instance.id, driverKind: instance.driverKind })) return `${modelLabel} · Matrix AI · ChatGPT subscription`;
  if (isChatgptPlanBotRoute({ instanceId: instance.id, driverKind: instance.driverKind })) return `${modelLabel} · ChatGPT subscription`;
  if (isManagedPiBotRoute({ instanceId: instance.id, driverKind: instance.driverKind }) || isLegacyMatrixSdkProvider(instance)) {
    return `${modelLabel} · Matrix AI`;
  }
  return [modelLabel, instance.connectionLabel,
    instance.driverKind === "matrix_pi" ? "Pi" : instance.displayName].filter(Boolean).join(" · ");
}
