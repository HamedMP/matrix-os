import type { AiProviderSnapshotV3, ProviderAccount, ProviderAccessSource } from "@matrix-os/contracts";
import type { HarnessConfiguration } from "./provider-settings-persistence.js";

/** Local CLI evidence belongs to one exact native route, never a shared account. */
export function projectHermesNativeRouteObservation(input: {
  driver: AiProviderSnapshotV3["drivers"][number] | undefined;
  stored: HarnessConfiguration;
  source: ProviderAccessSource | undefined;
  accounts: ProviderAccount[];
  now: Date;
}) {
  const { driver, stored, source } = input;
  const observed = driver?.nativeRouteObservation;
  if (!observed || stored.harness !== "hermes" || driver?.id !== "hermes"
    || driver.installState !== "installed" || !["ready", "degraded"].includes(driver.health)
    || !stored.enabled || stored.route.kind !== "configurable"
    || source?.id !== "owner_anthropic_profile" || source.kind !== "provider_account"
    || source.fundingKind !== "owner_account" || source.providerId !== "anthropic"
    || source.accountId !== "owner_anthropic" || stored.selectedAccountId !== "owner_anthropic"
    || stored.accessSourceId !== source.id || observed.credentialKind !== "provider_profile"
    || observed.providerId !== stored.route.providerId || observed.modelId !== stored.route.modelId
    || !source.eligibleModelIds.includes(observed.modelId)
    || !["unknown", "ready", "stale"].includes(source.readiness.state)) return {};
  const account = input.accounts.find(account => account.id === stored.selectedAccountId);
  if (!account || account.authMethod !== "terminal" || account.providerId !== observed.providerId
    || !["unknown", "authenticated"].includes(account.authState)) return {};
  const checked = Date.parse(observed.localObservation.checkedAt ?? "");
  const expires = Date.parse(observed.localObservation.staleAfter ?? "");
  if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > +input.now
    || expires <= checked || expires - checked > 5_000) return {};
  // Preserve expired timestamps for historical copy only; never promote readiness.
  return { localObservation: observed.localObservation };
}
