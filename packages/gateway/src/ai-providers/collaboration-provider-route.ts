import type { AiProviderSnapshotV3, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import type { CollaborationChatProviderRoute } from "./snapshot-read-options.js";

const NO_ACTIVE_PROVIDER_ROUTE: AiProviderSnapshotV3["active"] = {
  providerInstanceId: null,
  accessSourceId: null,
  modelId: null,
};

/** Project collaboration follows saved Settings intent, never the inventory's credential priority. */
export function savedCollaborationRoute(
  canonical: AiProviderSnapshotV3,
  config: ProviderSettingsConfiguration,
  projected?: ProviderSettingsSnapshot,
  chatRoute?: CollaborationChatProviderRoute,
): AiProviderSnapshotV3["active"] {
  const enabledNative = config.harnesses.filter((harness) =>
    harness.enabled && (harness.harness === "codex" || harness.harness === "claude"));
  const ownerConfigured = enabledNative.filter((harness) => harness.enablementOrigin === "owner_configuration");
  const inventoryActive = canonical.instances.find((instance) => instance.id === canonical.active.providerInstanceId);
  const activeHarness = inventoryActive?.driverId === "codex"
    ? "codex" as const
    : inventoryActive?.driverId === "kernel" || inventoryActive?.driverId === "claude_code"
      ? "claude" as const
      : null;
  const boundHarnesses = chatRoute ? enabledNative.filter((candidate) =>
    candidate.harness === (chatRoute.driverKind === "codex" ? "codex" : "claude")) : [];
  const harness = chatRoute
    ? boundHarnesses.length === 1 ? boundHarnesses[0] : undefined
    : enabledNative.length === 1
    ? enabledNative[0]
    : ownerConfigured.length === 1
      ? ownerConfigured[0]
      : activeHarness === null
        ? undefined
        : enabledNative.filter((candidate) => candidate.harness === activeHarness).length === 1
          ? enabledNative.find((candidate) => candidate.harness === activeHarness)
          : undefined;
  if (!harness) return NO_ACTIVE_PROVIDER_ROUTE;
  if (harness.accessSourceId === null) return NO_ACTIVE_PROVIDER_ROUTE;
  const source = canonical.accessSources.find((candidate) => candidate.id === harness.accessSourceId);
  const model = canonical.models.find((candidate) => candidate.id === (chatRoute?.modelId ?? harness.route.modelId));
  if (!source || !model || source.vendor !== harness.route.providerId
    || !source.eligibleModelIds.includes(model.id) || !model.eligibleAccessSourceIds.includes(source.id)) {
    return NO_ACTIVE_PROVIDER_ROUTE;
  }
  const compatible = canonical.instances.filter((instance) => instance.accessSourceId === source.id
    && instance.accountId === harness.selectedAccountId && instance.modelIds.includes(model.id)
    && (harness.harness === "codex" ? instance.driverId === "codex"
      : instance.driverId === "claude_code" || instance.driverId === "kernel"));
  const exact = compatible.filter((instance) => instance.driverId === harness.driverId);
  const instance = exact.length === 1 ? exact[0] : exact.length === 0 && compatible.length === 1 ? compatible[0] : undefined;
  const nativeCodexSubscription = harness.harness === "codex"
    && source.id === "owner_openai_profile" && source.fundingKind === "owner_account";
  const projectedHarness = nativeCodexSubscription
    ? projected?.harnesses.find((candidate) => candidate.id === harness.id && candidate.harness === "codex")
    : undefined;
  const projectedSource = nativeCodexSubscription
    ? projected?.accessSources.find((candidate) => candidate.id === source.id)
    : undefined;
  const ready = nativeCodexSubscription
    ? projectedHarness?.enabled === true && projectedHarness.authState === "authenticated"
      && projectedHarness.accessSourceId === source.id
      && projectedHarness.selectedAccountId === harness.selectedAccountId
      && projectedHarness.route.providerId === harness.route.providerId
      && projectedHarness.route.modelId === harness.route.modelId
      && projectedSource?.readiness.state === "ready"
    : instance?.readiness.state === "ready" && source.state === "ready";
  return instance && ready
    ? { providerInstanceId: instance.id, accessSourceId: source.id, modelId: model.id }
    : NO_ACTIVE_PROVIDER_ROUTE;
}
