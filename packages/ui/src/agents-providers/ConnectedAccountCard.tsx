import type { ReactNode } from "react";
import type { ProviderAccount, ProviderAccessSource, ProviderHarnessInstance } from "@matrix-os/contracts";
import { AllowanceMeter } from "./AllowanceMeter.js";
import { shortDate, usageLines } from "./utils.js";

/** Connected presentation consumes observed identity and usage, never inferred plan limits. */
export function ConnectedAccountCard({ harness, account, source, action, disabled, onRefresh }: {
  harness: ProviderHarnessInstance;
  account?: ProviderAccount;
  source?: ProviderAccessSource;
  action?: ReactNode;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const usage = source ? usageLines(source.usage) : null;
  const label = account?.authMethod === "api_key" ? "API key"
    : harness.harness === "codex" ? "ChatGPT account"
    : harness.harness === "claude" ? "Claude account" : "Provider account";
  return <section className="matrix-ap-connected" aria-label={`${harness.displayName} connection`}>
    <h3>Connection</h3>
    <div className="matrix-ap-account">
      <div className="matrix-ap-account-main"><div>
        <strong>{account?.connectionDetails?.planName ?? label}</strong>
        <span>{account?.connectionDetails?.email ?? account?.displayName ?? source?.displayName ?? "Account information unavailable"}</span>
      </div></div>
      <div className="matrix-ap-account-usage">
        <strong>{usage?.primary ?? "Usage unavailable"}</strong>
        {source?.usage.kind === "subscription_allowance" ? <>
          <AllowanceMeter label={account?.displayName ?? harness.displayName} usage={source.usage} />
          <span>{usage?.secondary}</span>
        </> : null}
        {usage?.stale ? <span>Usage last confirmed {shortDate(source?.usage.asOf ?? null)}</span> : null}
      </div>
      <div className="matrix-ap-account-actions">{action ?? <button type="button" className="matrix-ap-link-button" disabled title="Refresh or update this computer to change accounts in Settings">Change account</button>}</div>
    </div>
    {!action || !usage || source?.usage.kind === "unavailable" ? <button type="button" className="matrix-ap-link-button" disabled={disabled} onClick={onRefresh}>Check account again</button> : null}
  </section>;
}
