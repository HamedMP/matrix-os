import { renewStaleHermesObservation, projectHermesObservationForRenewal, type NativeObservationReadScope } from "./hermes-observation-renewal.js";
import { AiNativeHarnessCatalogSchema, ProviderAccessSourceSchema, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import type { GenericHarnessModelCatalog, GenericHarnessModelCatalogReader } from "./generic-harness-model-catalog.js";
import type { AgentRuntimeSource } from "../agent-config/service.js";

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
export type CanonicalNativeHarnessCatalogReader = ((refresh: boolean, scope?: NativeObservationReadScope) => Promise<Catalog>)
  & { renewStale: (catalog: Catalog, scope: NativeObservationReadScope) => Promise<Catalog> };

export function createCanonicalNativeHarnessCatalogReader(reader: GenericHarnessModelCatalogReader,
  options: { hermesRuntimeSource?: AgentRuntimeSource; now?: () => Date } = {},
): CanonicalNativeHarnessCatalogReader {
  let pending: { coding: Promise<Catalog>; hermes: Promise<Catalog> } | null = null;
  const now = options.now ?? (() => new Date());
  const renewStale = (catalog: Catalog, scope: NativeObservationReadScope) => renewStaleHermesObservation(catalog, options.hermesRuntimeSource, now, scope);
  const read = async (refresh: boolean, scope: NativeObservationReadScope = { deadline: +now() + 13000 }) => {
    scope.signal?.throwIfAborted();
    if (!pending) {
      const coding = Promise.resolve().then(() => reader.getCatalog({ refresh })).then(canonicalCatalog).catch((error: unknown): Catalog => {
        console.warn("[ai-providers] Native catalog unavailable", { errorClass: error instanceof Error ? error.name : "Unknown" });
        return { profiles: [], failures: ["pi", "opencode"] };
      });
      const hermes = options.hermesRuntimeSource
        ? Promise.resolve().then(() => {
          // A cached observation can expire during the other bounded catalog
          // probes. Renew native metadata without extending its five-second TTL.
          options.hermesRuntimeSource!.invalidate?.();
          return options.hermesRuntimeSource!(AbortSignal.timeout(6500));
        })
          .then((snapshot) => projectHermesObservationForRenewal(snapshot, now()))
          .catch((error: unknown): Catalog => {
            console.warn("[ai-providers] Hermes native catalog unavailable", { errorClass: error instanceof Error ? error.name : "Unknown" });
            return { profiles: [], failures: ["hermes"] };
          })
        : Promise.resolve<Catalog>({ profiles: [], failures: [] });
      const attempt = { coding, hermes };
      pending = attempt;
      void Promise.allSettled([coding, hermes]).then(() => { if (pending === attempt) pending = null; });
    }
    const bounded = async (attempt: Promise<Catalog>, failures: Catalog["failures"]): Promise<Catalog> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([attempt, new Promise<Catalog>((_, reject) => {
          onAbort = () => reject(scope.signal?.reason);
          scope.signal?.addEventListener("abort", onAbort, { once: true });
          if (scope.signal?.aborted) onAbort();
        }), new Promise<Catalog>((resolve) => {
          timer = setTimeout(() => resolve({ profiles: [], failures }), Math.max(0, Math.min(6500, scope.deadline - +now())));
        })]);
      } finally { if (timer) clearTimeout(timer); if (onAbort) scope.signal?.removeEventListener("abort", onAbort); }
    };
    const [coding, hermes] = await Promise.all([bounded(pending.coding, ["pi", "opencode"]), bounded(pending.hermes, ["hermes"])]);
    const hasRoom = coding.profiles.length + hermes.profiles.length <= 48;
    const catalog = AiNativeHarnessCatalogSchema.parse({ profiles: [...coding.profiles, ...(hasRoom ? hermes.profiles : [])],
      failures: [...coding.failures, ...(hasRoom ? hermes.failures : ["hermes"])] });
    return scope.deferRenewal ? catalog : renewStale(catalog, scope);
  };
  return Object.assign(read, { renewStale });
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
    displayName: `${profile.harness === "pi" ? "Pi" : profile.harness === "hermes" ? "Hermes" : "OpenCode"} account`,
    readiness: { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" },
    localObservation: profile.localObservation, eligibleModelIds: profile.models.filter((model) => model.enabled).map((model) => model.id),
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: profile.localObservation.checkedAt },
  })) };
}
