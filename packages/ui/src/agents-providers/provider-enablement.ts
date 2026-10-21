import {
  isLocallyObservedNativeHarnessRoute,
  isSupportedGenericHarnessCredentialRoute,
  type ProviderAccessSource,
  type ProviderHarnessInstance,
} from "@matrix-os/contracts";

/** Explain canonical enablement prerequisites without asserting authentication readiness. */
export function providerEnablementBlockReason(
  harness: ProviderHarnessInstance,
  sources: readonly ProviderAccessSource[],
  now: Date = new Date(),
): string | null {
  // An owner's explicit Off remains available during credential/runtime loss.
  if (harness.configuredEnabled ?? harness.enabled) return null;
  if (harness.installState !== "installed") return "Install this agent before enabling it.";
  if (harness.harness === "claude" || harness.harness === "codex") return null;
  const source = sources.find(candidate => candidate.id === harness.accessSourceId);
  if (!isSupportedGenericHarnessCredentialRoute(harness, source)) {
    return "Connect an account before enabling this agent.";
  }
  if (source?.kind === "harness_profile" && source.localObservation !== undefined
    && !isLocallyObservedNativeHarnessRoute(harness, source, now)) {
    return "Check this agent's account again before enabling it.";
  }
  return null;
}
