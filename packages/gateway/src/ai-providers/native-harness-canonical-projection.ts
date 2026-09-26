import { AiNativeHarnessCatalogSchema, ProviderAccessSourceSchema, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import type { GenericHarnessModelCatalog, GenericHarnessModelCatalogReader } from "./generic-harness-model-catalog.js";

type Catalog = NonNullable<AiProviderSnapshotV3["nativeHarnessCatalog"]>;
const unknownObservation = { state: "unknown" as const, checkedAt: null, staleAfter: null };
function canonicalCatalog(catalog: GenericHarnessModelCatalog): Catalog {
  const profiles: Catalog["profiles"] = [];
  const failures: Catalog["failures"] = [];
  for (const harness of ["pi", "opencode"] as const) {
    if (catalog.failures.includes(harness)) { failures.push(harness); continue; }
    const result = AiNativeHarnessCatalogSchema.safeParse({ profiles: catalog.accessSources
      .filter((source) => source.kind === "harness_profile" && source.harness === harness).map((source) => ({
        harness, providerId: source.providerId,
        providerDisplayName: catalog.providers.find((provider) => provider.id === source.providerId)?.displayName,
        models: (catalog.providers.find((provider) => provider.id === source.providerId)?.models ?? [])
          .filter((model) => source.eligibleModelIds.includes(model.id)),
        defaultModelId: source.eligibleModelIds.includes(catalog.nativeDefaults?.[harness] ?? "")
          ? catalog.nativeDefaults?.[harness] ?? null : null,
        localObservation: source.localObservation ?? unknownObservation,
      })), failures: [] });
    if (result.success) profiles.push(...result.data.profiles);
    else failures.push(harness);
  }
  return AiNativeHarnessCatalogSchema.parse({ profiles, failures });
}
export function createCanonicalNativeHarnessCatalogReader(reader: GenericHarnessModelCatalogReader): (refresh: boolean) => Promise<Catalog> {
  let pending: Promise<Catalog> | null = null;
  return async (refresh) => {
    if (!pending) {
      const attempt = Promise.resolve().then(() => reader.getCatalog({ refresh })).then(canonicalCatalog).catch((error: unknown): Catalog => {
        console.warn("[ai-providers] Native catalog unavailable", { errorClass: error instanceof Error ? error.name : "Unknown" });
        return { profiles: [], failures: ["pi", "opencode"] };
      });
      pending = attempt.finally(() => { pending = null; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<Catalog>((resolve) => {
        timer = setTimeout(() => resolve({ profiles: [], failures: ["pi", "opencode"] }), 6500);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
}

/** Compatibility projection: all observations/defaults originate in canonical V3. */
export function projectCanonicalNativeHarnessCatalog(catalog: Catalog): GenericHarnessModelCatalog {
  const providers: GenericHarnessModelCatalog["providers"] = [];
  const nativeDefaults: GenericHarnessModelCatalog["nativeDefaults"] = {};
  for (const profile of catalog.profiles) {
    let provider = providers.find((candidate) => candidate.id === profile.providerId);
    if (!provider) { provider = { id: profile.providerId, displayName: profile.providerDisplayName, models: [] }; providers.push(provider); }
    for (const model of profile.models) if (!provider.models.some((candidate) => candidate.id === model.id)) provider.models.push(model);
    if (profile.defaultModelId) nativeDefaults[profile.harness] = profile.defaultModelId;
  }
  return { providers, nativeDefaults, failures: catalog.failures, accessSources: catalog.profiles.map((profile) => ProviderAccessSourceSchema.parse({
    id: `harness_${profile.harness}_${profile.providerId}`, kind: "harness_profile", harness: profile.harness,
    fundingKind: "owner_account", providerId: profile.providerId, accountId: null,
    displayName: `${profile.harness === "pi" ? "Pi" : "OpenCode"} account`,
    readiness: { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" },
    localObservation: profile.localObservation, eligibleModelIds: profile.models.filter((model) => model.enabled).map((model) => model.id),
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: profile.localObservation.checkedAt },
  })) };
}
