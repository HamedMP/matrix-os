import { isNativeGenericHarnessCredentialRoute, isSupportedGenericHarnessCredentialRoute, type ProviderAccount, type ProviderAccessSource, type ProviderHarnessInstance } from "@matrix-os/contracts";

function fresh(observation: ProviderHarnessInstance["localObservation"]): boolean {
  if (observation?.state !== "present_unverified") return false;
  const checked = Date.parse(observation.checkedAt ?? "");
  const expires = Date.parse(observation.staleAfter ?? "");
  return Number.isFinite(checked) && checked <= Date.now() && Number.isFinite(expires) && expires > Date.now();
}

/** A configured credential is a connection; execution readiness stays canonical. */
export function hasConfiguredConnection(harness: Pick<ProviderHarnessInstance, "installState" | "authState">
  & Partial<Pick<ProviderHarnessInstance, "enabled" | "configuredEnabled" | "localObservation" | "harness" | "route" | "accessSourceId">>, source?: ProviderAccessSource): boolean {
  if (harness.installState !== "installed" || (harness.configuredEnabled ?? harness.enabled) === false
    || ["unauthenticated", "failed", "expired", "authenticating"].includes(harness.authState)
    || (source && ["invalid", "expired", "auth_required"].includes(source.readiness.state))) return false;
  if (source && harness.harness && harness.route && harness.accessSourceId !== undefined
    && !isSupportedGenericHarnessCredentialRoute({ harness: harness.harness, route: harness.route, accessSourceId: harness.accessSourceId }, source)) return false;
  return harness.authState === "authenticated" || fresh(harness.localObservation) || fresh(source?.localObservation);
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


/** Historical profile presence is not logout or live execution authority. */
export function hasStaleHermesConnection(harness: Pick<ProviderHarnessInstance, "installState" | "authState">
  & Partial<Pick<ProviderHarnessInstance, "enabled" | "configuredEnabled" | "localObservation" | "harness" | "route" | "accessSourceId">>, source?: ProviderAccessSource): boolean {
  if (harness.harness !== "hermes" || harness.installState !== "installed"
    || (harness.configuredEnabled ?? harness.enabled) === false || harness.authState !== "unknown"
    || !source || ["invalid", "expired", "auth_required"].includes(source.readiness.state)
    || !harness.route || harness.accessSourceId === undefined
    || !isNativeGenericHarnessCredentialRoute({ harness: harness.harness, route: harness.route, accessSourceId: harness.accessSourceId }, source)) return false;
  const observation = source.localObservation ?? harness.localObservation;
  const checked = Date.parse(observation?.checkedAt ?? "");
  const expires = Date.parse(observation?.staleAfter ?? "");
  return observation?.state === "present_unverified" && Number.isFinite(checked) && Number.isFinite(expires)
    && expires > checked && expires - checked <= 5000 && checked <= Date.now() && expires <= Date.now();
}

/** Native account shortcuts must not borrow a Matrix-funded route or another account. */
export function isNativeAccountSource(kind: "codex" | "claude", source?: ProviderAccessSource, account?: ProviderAccount): boolean {
  const matchesProvider = (provider: string) => provider === (kind === "claude" ? "anthropic" : "openai")
    || (kind === "codex" && provider === "openai-codex");
  if (account?.providerId && !matchesProvider(account.providerId)) return false;
  if (!source) return true; // Legacy native status can be observed without a source descriptor.
  // Harness profiles belong to generic runtimes; none names official Codex or Claude Code.
  if (source.kind === "matrix_gateway" || source.kind === "harness_profile" || !matchesProvider(source.providerId)) return false;
  if ((source.accountId && account?.id !== source.accountId) || (account && account.accessSourceId !== source.id)) return false;
  return source.fundingKind === "owner_subscription" || source.fundingKind === "owner_api_key"
    || (source.fundingKind === "owner_account" && Boolean(account));
}
