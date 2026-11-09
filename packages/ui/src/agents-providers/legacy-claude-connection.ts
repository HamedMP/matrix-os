import type {ProviderAccount, ProviderAccessSource, ProviderHarnessInstance} from "@matrix-os/contracts";

/** Matches the native metadata reader's identity lifetime; never execution authority. */
const NATIVE_IDENTITY_LIFETIME_MS = 30_000;
export function nativeClaudeAuthenticationExpiry(account: ProviderAccount): string | null {
  if (account.id !== "owner_claude_profile" || !account.lastCheckedAt) return null;
  const checked = Date.parse(account.lastCheckedAt);
  const expiry = new Date(checked + NATIVE_IDENTITY_LIFETIME_MS);
  return Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null;
}

/** Observe CLI-owned authentication independently of the saved execution route. */
export function nativeClaudeConnection(harness: ProviderHarnessInstance,
  accounts: readonly ProviderAccount[], sources: readonly ProviderAccessSource[], now = Date.now(), observedAt = now) {
  if (!Number.isFinite(now) || !Number.isFinite(observedAt)) return;
  if (harness.harness !== "claude" || harness.installState !== "installed"
    || harness.route.kind !== "fixed" || harness.route.providerId !== "anthropic") return;
  // For an already selected native route, retain the server's exact binding
  // verification; a saved account record cannot override a rejected live route.
  if (harness.accessSourceId === "owner_claude_profile" && harness.selectedAccountId === "owner_claude_profile"
    && harness.authState !== "authenticated") return;
  const account = accounts.find(item => item.id === "owner_claude_profile" && item.providerId === "anthropic"
    && item.authMethod === "terminal" && item.authState === "authenticated" && item.accessSourceId === "owner_claude_profile");
  if (!account || !harness.accountIds.includes(account.id)) return;
  const checked = Date.parse(account.lastCheckedAt ?? "");
  const expiry = Date.parse(nativeClaudeAuthenticationExpiry(account) ?? "");
  if (!Number.isFinite(checked) || checked > observedAt || checked > now || !Number.isFinite(expiry) || expiry <= now) return;
  const source = sources.find(item => item.id === account.accessSourceId && item.kind === "provider_account"
    && item.providerId === "anthropic" && item.fundingKind === "owner_account" && item.accountId === account.id
    && (item.readiness.state === "unknown" || item.readiness.state === "ready"));
  return source ? {account, source} : undefined;
}

/** Recovery changes execution intent only after an explicit owner action. */
export function legacyClaudeNativeConnection(harness: ProviderHarnessInstance,
  accounts: readonly ProviderAccount[], sources: readonly ProviderAccessSource[], now = Date.now(), observedAt = now) {
  if (harness.id !== "harness_kernel" || harness.enablementOrigin === "owner_configuration" || harness.configuredAccessSourceId !== "matrix_included"
    || harness.accessSourceId !== null || harness.selectedAccountId !== null) return;
  return nativeClaudeConnection(harness, accounts, sources, now, observedAt);
}
