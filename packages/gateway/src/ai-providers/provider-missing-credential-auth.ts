import type { AiProviderSnapshotV3, ProviderAccessSource } from "@matrix-os/contracts";
import type { HarnessConfiguration } from "./provider-settings-persistence.js";

/** Preserve negative credential evidence even when no owner account is projected. */
export function projectMissingCredentialAuth(input: {
  canonical: AiProviderSnapshotV3;
  stored: HarnessConfiguration;
  source: ProviderAccessSource | undefined;
  driver: AiProviderSnapshotV3["drivers"][number] | undefined;
  now: Date;
}): "unauthenticated" | undefined {
  if (input.source || !input.stored.accessSourceId) return undefined;
  const source = input.canonical.accessSources.find((candidate) => candidate.id === input.stored.accessSourceId);
  if (!source || source.vendor !== input.stored.route.providerId
    || !source.eligibleModelIds.includes(input.stored.route.modelId)
    || !["owner_account", "owner_api_key"].includes(source.fundingKind)
    || !["setup_required", "auth_required"].includes(source.state)) return undefined;
  // Unknown, present or stale local evidence retains the existing recovery path.
  const isFreshAbsent = (observation: NonNullable<typeof source.localObservation>) =>
    observation.state === "absent" && Date.parse(observation.checkedAt ?? "") <= +input.now
      && Date.parse(observation.staleAfter ?? "") > +input.now;
  if (source.localObservation && !isFreshAbsent(source.localObservation)
    || input.driver?.nativeRouteObservation && !isFreshAbsent(input.driver.nativeRouteObservation.localObservation)) return undefined;
  // This never supplies an account/source binding or makes a route executable.
  return "unauthenticated";
}
