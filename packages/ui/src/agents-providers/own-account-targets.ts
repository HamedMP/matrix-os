import { isLocallyObservedNativeHarnessRoute, isSupportedGenericHarnessCredentialRoute,
  type ProviderAccessSource, type ProviderHarnessInstance, type ProviderSettingsSnapshot } from "@matrix-os/contracts";

type Target = { source: ProviderAccessSource; model: ProviderSettingsSnapshot["modelProviders"][number]["models"][number] };

/** Selection binding is independent of the short-lived observation permitting an attempt. */
export function ownAccountTargets(snapshot: ProviderSettingsSnapshot, harness: ProviderHarnessInstance, fresh = true): Target[] {
  return snapshot.accessSources.flatMap((source) => {
    if (source.kind === "matrix_gateway") return [];
    const provider = snapshot.modelProviders.find((candidate) => candidate.id === source.providerId);
    return provider?.models.filter((model) => {
      const selected = { ...harness, accessSourceId: source.id,
        route: { kind: "configurable" as const, providerId: source.providerId, modelId: model.id } };
      return model.enabled && source.eligibleModelIds.includes(model.id)
        && isSupportedGenericHarnessCredentialRoute(selected, source)
        && (!fresh || source.readiness.state === "ready" || isLocallyObservedNativeHarnessRoute(selected, source));
    }).map((model) => ({ source, model })) ?? [];
  });
}

export function preferredOwnAccountTarget(targets: Target[], harness: ProviderHarnessInstance): Target | undefined {
  return targets.find(({ source, model }) => source.id === harness.accessSourceId && model.id === harness.route.modelId)
    ?? targets.find(({ model }) => model.id === harness.route.modelId) ?? targets[0];
}
