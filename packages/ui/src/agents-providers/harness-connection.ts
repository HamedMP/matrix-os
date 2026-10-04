import { isSupportedGenericHarnessCredentialRoute, type ProviderAccount, type ProviderAccessSource, type ProviderHarnessInstance } from "@matrix-os/contracts";

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

/** Resolve only the account belonging to this route; never borrow another native account. */
export function resolveHarnessConnection(harness: ProviderHarnessInstance, accounts: readonly ProviderAccount[], sources: readonly ProviderAccessSource[]) {
  const selected = accounts.find(account => account.id === harness.selectedAccountId);
  const source = sources.find(item => item.id === (harness.accessSourceId ?? selected?.accessSourceId));
  const linkedAccounts = source ? accounts.filter(item => item.accessSourceId === source.id) : [];
  const account = source
    ? source.accountId ? linkedAccounts.find(item => item.id === source.accountId)
      : selected?.accessSourceId === source.id ? selected : linkedAccounts.length === 1 ? linkedAccounts[0] : undefined
    : harness.accessSourceId === null ? selected : undefined;
  return { account, source };
}
