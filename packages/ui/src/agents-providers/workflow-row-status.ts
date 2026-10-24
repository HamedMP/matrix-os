import type { ProviderAccessSource, ProviderHarnessInstance } from "@matrix-os/contracts";
import { hasConfiguredConnection, hasStaleHermesConnection } from "./harness-connection.js";
/** Mounted rows share progress without clearing another row's active operation. */
export function updateWorkflowRowStatus(current: Record<string, string>, id: string, status: string | null): Record<string, string> {
  if (current[id] === status || (!status && !(id in current))) return current;
  const next = { ...current };
  if (!status) delete next[id];
  else if (id in next || Object.keys(next).length < 32) next[id] = status;
  return next;
}

/** Failed historical receipts do not negate the currently selected connection. */
export function resolvedWorkflowRowStatus(harness: ProviderHarnessInstance, source: ProviderAccessSource | undefined, override?: string): string {
  if (override === "Installing" || override === "Uninstalling") return override;
  if (harness.installState === "missing") return "Not installed";
  if (harness.installState === "unknown") return "Checking installation";
  if (harness.installState === "failed") return "Install failed";
  if (harness.installState === "installing") return "Installing";
  // Verified native identity is independent of saved Off and Bot capability.
  // Do not borrow an account label or another source's authentication.
  if (harness.harness === "claude" && harness.authState === "authenticated"
    && harness.route.providerId === "anthropic" && source?.id === "owner_claude_profile"
    && source.kind === "provider_account" && source.providerId === "anthropic" && source.fundingKind === "owner_account"
    && source.accountId !== null && harness.selectedAccountId === source.accountId && harness.accessSourceId === source.id) return "Connected";
  if (override === "Connecting" || harness.authState === "authenticating") return "Connecting";
  if (hasConfiguredConnection(harness, source)) return "Connected";
  if (hasStaleHermesConnection(harness, source)) return "Checking connection";
  return override === "Couldn't connect" ? override : "Not connected";
}
