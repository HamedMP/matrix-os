import type {ProviderAccount, ProviderSettingsSnapshot} from "@matrix-os/contracts";

function nativeAccount(account: ProviderAccount): boolean {
  return account.authMethod === "terminal" && (account.id === "owner_claude_profile" || account.id === "owner_codex");
}
/** Check timestamps are not identity changes; they must not invalidate every Chat catalog. */
export function nativeAuthenticationFingerprint(snapshot: ProviderSettingsSnapshot): string {
  return JSON.stringify(snapshot.accounts.filter(nativeAccount).map(account => [account.id, account.providerId,
    account.accessSourceId, account.authState, account.connectionDetails?.email ?? account.displayName]));
}
