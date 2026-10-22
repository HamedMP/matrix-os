import { AiNativeHarnessCatalogSchema, isNativeGenericHarnessCredentialRoute,
  type AiProviderSnapshotV3, type ProviderAccessSource, type ProviderHarnessInstance } from "@matrix-os/contracts";
import type { AgentRuntimeSettingsSnapshot } from "../agent-config/service.js";

type Catalog = NonNullable<AiProviderSnapshotV3["nativeHarnessCatalog"]>;

/** V3 uses provider-prefixed IDs; native Hermes RPC and rollback receipts use bare IDs. */
export function hermesNativeModelId(
  harness: Pick<ProviderHarnessInstance, "harness" | "accessSourceId" | "route">,
  source: ProviderAccessSource | null | undefined,
): string | null {
  if (!["hermes", "openclaw"].includes(harness.harness) || !isNativeGenericHarnessCredentialRoute(harness, source)
    || !source?.eligibleModelIds.includes(harness.route.modelId)) return null;
  const prefix = `${source.providerId}:`;
  const model = harness.route.modelId;
  if (!model.startsWith(prefix) || model.length === prefix.length) return null;
  const bare = model.slice(prefix.length);
  return bare.startsWith(prefix) ? null : bare;
}

/** Native runtime metadata qualifies each exact provider independently of the default. */
export function projectHermesNativeCatalog(snapshot: AgentRuntimeSettingsSnapshot, now: Date): Catalog {
  const runtime = snapshot.runtime.options.find(candidate => candidate.id === "hermes");
  if (snapshot.messaging.runtime !== "hermes") return { profiles: [], failures: [] };
  const profiles: Catalog["profiles"] = []; let failed = false;
  for (const id of ["openai-codex", "openai-api", "anthropic", "openrouter"]) {
    const selected = snapshot.messaging.provider === id;
    const observations = snapshot.nativeProfileObservations?.filter(profile => profile.providerId === id) ?? [];
    const observed = selected ? runtime?.nativeRouteObservation : observations.length === 1 ? observations[0] : undefined;
    const providers = snapshot.providers.filter(provider => provider.runtime === "hermes" && provider.id === id);
    if (!selected && !providers.length && !observations.length) continue;
    const provider = providers.length === 1 ? providers[0] : undefined;
    // Native Claude OAuth remains a separate legacy route, never a Pi/API credential.
    if (id !== "openai-codex" && observed?.credentialKind !== "api_key") continue;
    const checked = Date.parse(observed?.localObservation.checkedAt ?? "");
    const expires = Date.parse(observed?.localObservation.staleAfter ?? "");
    if (snapshot.runtime.selected !== "hermes" || runtime?.installState !== "installed" || !["healthy", "degraded"].includes(runtime.health)
      || !snapshot.messaging.configured || !provider || !observed
      || provider.authStatus.state !== "ready" || provider.authStatus.authenticated !== true
      || observed.localObservation.state !== "present_unverified" || observed.providerId !== id
      || (selected && runtime?.nativeRouteObservation?.modelId !== snapshot.messaging.model)
      || provider.models.some(model => model.id.startsWith(`${id}:`))
      || observed.credentialKind !== (id === "openai-codex" ? "provider_profile" : "api_key")
      || !Number.isFinite(checked) || !Number.isFinite(expires) || checked > +now || expires <= +now || expires <= checked || expires - checked > 5000) { failed = true; continue; }
    profiles.push({ harness: "hermes", providerId: id, providerDisplayName: provider.displayName,
      models: provider.models.filter(model => model.available).map(model => ({ id: `${id}:${model.id}`, displayName: model.displayName, enabled: true })),
      defaultModelId: selected ? `${id}:${snapshot.messaging.model}` : null, localObservation: observed.localObservation });
  }
  const result = AiNativeHarnessCatalogSchema.safeParse({ profiles, failures: failed ? ["hermes"] : [] });
  return result.success ? result.data : { profiles: [], failures: ["hermes"] };
}
