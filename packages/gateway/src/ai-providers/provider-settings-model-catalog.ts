import { MAX_PROVIDER_SETTINGS_MODELS, type AiProviderSnapshotV3, type ProviderAccessSource, type ProviderHarnessKind, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";

/** Bound the merged wire inventory without changing saved intent or native evidence. */
export function boundProviderSettingsModels(input: {
  modelProviders: ProviderSettingsSnapshot["modelProviders"];
  sources: ProviderAccessSource[];
  canonical: AiProviderSnapshotV3;
  config: ProviderSettingsConfiguration;
  nativeDefaults?: Partial<Record<"pi" | "opencode" | "hermes" | "openclaw", string>>;
}): { modelProviders: ProviderSettingsSnapshot["modelProviders"]; sources: ProviderAccessSource[] } {
  // Canonical models (128) plus saved harness routes (128) fit the wire cap.
  // Native defaults add at most four optional priorities. All sets are request-local.
  const required = new Set([...input.canonical.models.map(model => model.id), ...input.config.harnesses.map(harness => harness.route.modelId)]);
  const defaults = new Set(Object.values(input.nativeDefaults ?? {}));
  // At most one entry per bounded model-provider inventory; no retained process state.
  const retainedByProvider = new Map<string, Set<string>>();
  const modelProviders = input.modelProviders.map(provider => {
    if (provider.models.length <= MAX_PROVIDER_SETTINGS_MODELS) return provider;
    const retained = new Set<string>();
    for (const priority of [required, defaults, null]) {
      for (const model of provider.models) {
        if (retained.size >= MAX_PROVIDER_SETTINGS_MODELS) break;
        if (priority === null || priority.has(model.id)) retained.add(model.id);
      }
    }
    retainedByProvider.set(provider.id, retained);
    // Preserve discovery order and labels, including disabled models.
    return { ...provider, models: provider.models.filter(model => retained.has(model.id)) };
  });
  const sources = input.sources.map(source => {
    const retained = retainedByProvider.get(source.providerId);
    return retained ? { ...source, eligibleModelIds: source.eligibleModelIds.filter(id => retained.has(id)) } : source;
  });
  return { modelProviders, sources };
}

function fallbackRouteLabel(reference: string, fallback: string): string {
  const leaf = reference.split(/[/:]/).at(-1) ?? reference;
  const label = leaf.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const value = label || fallback;
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`.slice(0, 120);
}

export function retainFailedCatalogRoutes(input: {
  modelProviders: ProviderSettingsSnapshot["modelProviders"];
  sources: ProviderAccessSource[];
  config: ProviderSettingsConfiguration;
  failures: ReadonlySet<ProviderHarnessKind>;
  canonicalProviderIds: ReadonlySet<string>;
}): void {
  const referencedProviders = new Set(input.config.harnesses.map((harness) => harness.route.providerId));
  const referencedModels = new Set(input.config.harnesses.map((harness) => harness.route.modelId));
  for (const harness of input.config.harnesses) {
    if (!input.failures.has(harness.harness)) continue;
    let provider = input.modelProviders.find((candidate) => candidate.id === harness.route.providerId);
    if (!provider) {
      while (input.modelProviders.length >= 32) {
        const removable = input.modelProviders.findLastIndex((candidate) =>
          !input.canonicalProviderIds.has(candidate.id)
          && !referencedProviders.has(candidate.id));
        if (removable < 0) break;
        const [removed] = input.modelProviders.splice(removable, 1);
        for (let index = input.sources.length - 1; index >= 0; index -= 1) {
          const source = input.sources[index]!;
          if (source.kind === "harness_profile" && source.providerId === removed!.id) {
            input.sources.splice(index, 1);
          }
        }
      }
      if (input.modelProviders.length >= 32) continue;
      provider = {
        id: harness.route.providerId,
        displayName: fallbackRouteLabel(harness.route.providerId, "Unavailable provider"),
        models: [],
      };
      input.modelProviders.push(provider);
    }
    if (provider.models.some((model) => model.id === harness.route.modelId)) continue;
    if (provider.models.length >= MAX_PROVIDER_SETTINGS_MODELS) {
      const removable = provider.models.findLastIndex((model) => !referencedModels.has(model.id));
      if (removable < 0) continue;
      provider.models.splice(removable, 1);
    }
    provider.models.push({
      id: harness.route.modelId,
      displayName: fallbackRouteLabel(harness.route.modelId, "Unavailable model"),
      enabled: true,
    });
  }
}

