import type { ProviderHarnessKind, ProviderSettingsSnapshot } from "@matrix-os/contracts";

/** Consent completion needs the exact current native account, independently of
 * model execution readiness. A profile file's mere presence is insufficient.
 */
export function authenticatedNativeHarness(snapshot: ProviderSettingsSnapshot, id: string, kind: ProviderHarnessKind) {
  const exact = snapshot.harnesses.find(row => row.id === id && row.harness === kind);
  if (!exact || exact.installState !== "installed" || snapshot.access.mode !== "writable") return null;
  const account = snapshot.accounts?.find(row => row.id === exact.selectedAccountId);
  const source = snapshot.accessSources?.find(row => row.id === exact.accessSourceId);
  const authenticatedAccount = !!account && account.authState === "authenticated"
    && account.accessSourceId === exact.accessSourceId && account.providerId === exact.route.providerId
    && source?.accountId === account.id && source.providerId === account.providerId;
  return exact.authState === "authenticated" || authenticatedAccount ? exact : null;
}
