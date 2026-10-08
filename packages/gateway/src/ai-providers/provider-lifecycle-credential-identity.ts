import type { ProviderLifecycleAccount } from "./provider-settings-coordinators.js";

/** These two registered rows address one owner HOME's native Claude profile. */
export function isNativeClaudeLifecycleAccount(account: ProviderLifecycleAccount): boolean {
  return account.driverId === "claude_code" && account.harness === "claude"
    && account.providerId === "anthropic" && account.authMethod === "terminal"
    && account.id === "owner_claude_profile" && account.accessSourceId === "owner_claude_profile";
}

/** Count competing credentials, rather than aliases or separately revocable stores. */
export function lifecycleCredentialCompetition(accounts: ProviderLifecycleAccount[]): ProviderLifecycleAccount[] {
  const credentialIdentity = (account: ProviderLifecycleAccount) => {
    if (isNativeClaudeLifecycleAccount(account)
      || account.driverId === "claude_code" && account.providerId === "anthropic"
        && account.authMethod === "terminal" && account.id === "owner_anthropic"
        && account.accessSourceId === "owner_anthropic_profile") return "owner-claude-profile";
    // Unknown identities remain distinct; source/name similarity is not proof.
    return JSON.stringify([account.id, account.accessSourceId]);
  };
  return accounts.map(account => ({
    ...account,
    driverAccountCount: new Set(accounts.filter(candidate => candidate.driverId === account.driverId
      // Claude's owner key tombstone and native CLI logout address separate stores.
      && (account.driverId !== "claude_code" || (candidate.authMethod === "api_key") === (account.authMethod === "api_key")))
      .map(credentialIdentity)).size,
  })); // Invocation-local collections are bounded by the 128-account configuration.
}
