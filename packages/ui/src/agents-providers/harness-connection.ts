import { isSupportedGenericHarnessCredentialRoute, type ProviderAccessSource, type ProviderHarnessInstance } from "@matrix-os/contracts";

/** A configured credential is a connection; execution readiness stays canonical. */
export function hasConfiguredConnection(harness: Pick<ProviderHarnessInstance, "installState" | "authState">
  & Partial<Pick<ProviderHarnessInstance, "enabled" | "configuredEnabled" | "localObservation" | "harness" | "route" | "accessSourceId">>, source?: ProviderAccessSource): boolean {
  if (harness.installState !== "installed" || (harness.configuredEnabled ?? harness.enabled) === false
    || ["unauthenticated", "failed", "expired", "authenticating"].includes(harness.authState)
    || (source && ["invalid", "expired", "auth_required"].includes(source.readiness.state))) return false;
  if (source && harness.harness && harness.route && harness.accessSourceId !== undefined
    && !isSupportedGenericHarnessCredentialRoute({ harness: harness.harness, route: harness.route, accessSourceId: harness.accessSourceId }, source)) return false;
  return harness.authState === "authenticated" || harness.localObservation?.state === "present_unverified"
    || source?.localObservation?.state === "present_unverified";
}
