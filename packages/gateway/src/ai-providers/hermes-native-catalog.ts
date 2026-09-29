import { AiNativeHarnessCatalogSchema, isNativeGenericHarnessCredentialRoute,
  type AiProviderSnapshotV3, type ProviderAccessSource, type ProviderHarnessInstance } from "@matrix-os/contracts";
import type { AgentRuntimeSettingsSnapshot } from "../agent-config/service.js";

type Catalog = NonNullable<AiProviderSnapshotV3["nativeHarnessCatalog"]>;

/** V3 uses provider-prefixed IDs; native Hermes RPC and rollback receipts use bare IDs. */
export function hermesNativeModelId(
  harness: Pick<ProviderHarnessInstance, "harness" | "accessSourceId" | "route">,
  source: ProviderAccessSource | null | undefined,
): string | null {
  if (harness.harness !== "hermes" || !isNativeGenericHarnessCredentialRoute(harness, source)
    || !source?.eligibleModelIds.includes(harness.route.modelId)) return null;
  const prefix = "openai-codex:";
  const model = harness.route.modelId;
  if (!model.startsWith(prefix) || model.length === prefix.length) return null;
  const bare = model.slice(prefix.length);
  return bare.startsWith(prefix) ? null : bare;
}

/** Native runtime metadata qualifies its own profile independently of the default provider. */
export function projectHermesNativeCatalog(snapshot: AgentRuntimeSettingsSnapshot, now: Date): Catalog {
  const runtime = snapshot.runtime.options.find((candidate) => candidate.id === "hermes");
  if (snapshot.messaging.runtime !== "hermes") {
    return { profiles: [], failures: [] };
  }
  const selectedCodex = snapshot.messaging.provider === "openai-codex";
  const profileObservations = snapshot.nativeProfileObservations?.filter((profile) => profile.providerId === "openai-codex") ?? [];
  const observed = selectedCodex ? runtime?.nativeRouteObservation
    : profileObservations.length === 1 ? profileObservations[0] : undefined;
  const providers = snapshot.providers.filter((provider) => provider.runtime === "hermes" && provider.id === "openai-codex");
  if (!selectedCodex && providers.length === 0 && profileObservations.length === 0) return { profiles: [], failures: [] };
  const provider = providers.length === 1 ? providers[0] : undefined;
  const checked = Date.parse(observed?.localObservation.checkedAt ?? "");
  const expires = Date.parse(observed?.localObservation.staleAfter ?? "");
  if (snapshot.runtime.selected !== "hermes" || runtime?.installState !== "installed" || !["healthy", "degraded"].includes(runtime.health)
    || !snapshot.messaging.configured || !provider || !observed
    || provider.authStatus.state !== "ready" || provider.authStatus.authenticated !== true
    || observed.localObservation.state !== "present_unverified"
    || observed.providerId !== "openai-codex"
    || (selectedCodex && runtime?.nativeRouteObservation?.modelId !== snapshot.messaging.model)
    || provider.models.some((model) => model.id.startsWith("openai-codex:"))
    || observed.credentialKind !== "provider_profile" || !Number.isFinite(checked) || !Number.isFinite(expires)
    || checked > +now || expires <= +now || expires <= checked || expires - checked > 5_000) {
    return { profiles: [], failures: ["hermes"] };
  }
  const result = AiNativeHarnessCatalogSchema.safeParse({ profiles: [{
    harness: "hermes", providerId: "openai-codex", providerDisplayName: provider.displayName,
    models: provider.models.filter((model) => model.available).map((model) => ({
      id: `openai-codex:${model.id}`, displayName: model.displayName, enabled: true,
    })),
    defaultModelId: selectedCodex ? `openai-codex:${snapshot.messaging.model}` : null,
    localObservation: observed.localObservation,
  }], failures: [] });
  return result.success ? result.data : { profiles: [], failures: ["hermes"] };
}
