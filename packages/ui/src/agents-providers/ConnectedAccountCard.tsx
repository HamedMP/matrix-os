import type { ReactNode } from "react";
import type { ProviderAccount, ProviderAccessSource, ProviderHarnessInstance } from "@matrix-os/contracts";
import { AllowanceMeter } from "./AllowanceMeter.js";
import { connectedAccountLabel, providerName, shortDate, usageLines } from "./utils.js";

/** Connected presentation consumes observed identity and usage, never inferred plan limits. */
export function ConnectedAccountCard({ harness, account, source, action, disabled, onRefresh, saved = false }: {
  harness: ProviderHarnessInstance;
  account?: ProviderAccount;
  source?: ProviderAccessSource;
  action?: ReactNode;
  saved?: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  // A provider never shares an API key's usage with Matrix; name who bills it instead.
  const { apiKey, label } = connectedAccountLabel(harness.harness, account, source);
  const usage = source && !apiKey ? usageLines(source.usage) : null;
  return <section className="matrix-ap-connected" aria-label={`${harness.displayName} ${saved ? "saved account" : "connection"}`}>
    <h3>{saved ? "Saved account" : "Connection"}</h3>
    <div className="matrix-ap-account">
      <div className="matrix-ap-account-main"><div>
        <strong>{account?.connectionDetails?.planName ?? label}</strong>
        <span>{apiKey ? `Billed per request by ${providerName(account?.providerId ?? source?.providerId) ?? "your provider"}`
          : account?.connectionDetails?.email ?? account?.displayName ?? source?.displayName ?? "Account information unavailable"}</span>
      </div></div>
      {apiKey ? null : <div className="matrix-ap-account-usage">
        <strong>{usage?.primary ?? "Usage unavailable"}</strong>
        {source?.usage.kind === "subscription_allowance" ? <>
          <AllowanceMeter label={account?.displayName ?? harness.displayName} usage={source.usage} />
          <span>{usage?.secondary}</span>
        </> : null}
        {usage?.stale ? <span>Usage last confirmed {shortDate(source?.usage.asOf ?? null)}</span> : null}
      </div>}
      <div className="matrix-ap-account-actions">{action}</div>
    </div>
    {!action || !usage || source?.usage.kind === "unavailable" ? <button type="button" className="matrix-ap-link-button" disabled={disabled} onClick={onRefresh}>Check account again</button> : null}
  </section>;
}
