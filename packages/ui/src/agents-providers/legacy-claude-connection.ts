import type {ProviderAccount, ProviderAccessSource, ProviderHarnessInstance} from "@matrix-os/contracts";

/** Matches the native metadata reader's identity lifetime; never execution authority. */
const NATIVE_IDENTITY_LIFETIME_MS = 30_000;
export function nativeClaudeAuthenticationExpiry(account: ProviderAccount): string | null {
  if (account.id !== "owner_claude_profile" || !account.lastCheckedAt) return null;
  const checked = Date.parse(account.lastCheckedAt);
  const expiry = new Date(checked + NATIVE_IDENTITY_LIFETIME_MS);
  return Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null;
}

/** Recognize an old kernel default without changing its saved funding or enabled intent. */
export function legacyClaudeNativeConnection(harness: ProviderHarnessInstance,
  accounts: readonly ProviderAccount[], sources: readonly ProviderAccessSource[], now = Date.now()) {
  if (harness.id !== "harness_kernel" || harness.harness !== "claude" || harness.installState !== "installed"
    || harness.enablementOrigin === "owner_configuration" || harness.configuredAccessSourceId !== "matrix_included"
    || harness.accessSourceId !== null || harness.selectedAccountId !== null
    || harness.route.kind !== "fixed" || harness.route.providerId !== "anthropic") return;
  const account = accounts.find(item => item.id === "owner_claude_profile" && item.providerId === "anthropic"
    && item.authMethod === "terminal" && item.authState === "authenticated" && item.accessSourceId === "owner_claude_profile");
  if (!account || !harness.accountIds.includes(account.id)) return;
  const checked = Date.parse(account.lastCheckedAt ?? "");
  const expiry = Date.parse(nativeClaudeAuthenticationExpiry(account) ?? "");
  if (!Number.isFinite(checked) || checked > now || !Number.isFinite(expiry) || expiry <= now) return;
  const source = sources.find(item => item.id === account.accessSourceId && item.kind === "provider_account"
    && item.providerId === "anthropic" && item.fundingKind === "owner_account" && item.accountId === account.id
    && (item.readiness.state === "unknown" || item.readiness.state === "ready"));
  return source ? {account, source} : undefined;
}
