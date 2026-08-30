import { useState } from "react";
import type {
  ProviderAccount,
  ProviderAccessSource,
  ProviderConnectionAttempt,
  ProviderHarnessInstance,
} from "@matrix-os/contracts";
import { RemovalDialog } from "./RemovalDialog.js";
import type { ProviderSettingsMutationIntent } from "./types.js";
import { authLabel, titleCase, usageLines } from "./utils.js";

function AttemptAction({
  attempt,
  onOpenTerminal,
  onOpenBrowser,
}: {
  attempt: ProviderConnectionAttempt;
  onOpenTerminal: (sessionId: string) => void;
  onOpenBrowser: (path: string) => void;
}) {
  const action = attempt.action;
  if (action.kind === "open_terminal") {
    return <button type="button" className="matrix-ap-button matrix-ap-button-primary" onClick={() => onOpenTerminal(action.terminalSessionId)}>Continue in Terminal</button>;
  }
  if (action.kind === "open_browser") {
    return <button type="button" className="matrix-ap-button matrix-ap-button-primary" onClick={() => onOpenBrowser(action.authorizationPath)}>Continue in browser</button>;
  }
  if (action.kind === "enter_api_key") return <span className="matrix-ap-help">Continue in the secure credential prompt.</span>;
  if (action.kind === "wait") return <span className="matrix-ap-help">Waiting for authentication…</span>;
  if (action.kind === "retry") return <span className="matrix-ap-help">Authentication needs to be retried.</span>;
  return null;
}

export function AccountsPanel({
  harness,
  accounts,
  sources,
  attempt,
  disabled,
  canLogin,
  canLogout,
  canRemove,
  canReassign,
  onMutate,
  onOpenTerminal,
  onOpenBrowser,
}: {
  harness: ProviderHarnessInstance;
  accounts: ProviderAccount[];
  sources: ProviderAccessSource[];
  attempt: ProviderConnectionAttempt | null;
  disabled: boolean;
  canLogin: boolean;
  canLogout: boolean;
  canRemove: boolean;
  canReassign: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
  onOpenTerminal: (sessionId: string) => void;
  onOpenBrowser: (path: string) => void;
}) {
  const [removeAccount, setRemoveAccount] = useState<ProviderAccount | null>(null);
  const [showLoginMethods, setShowLoginMethods] = useState(false);

  return (
    <section className="matrix-ap-panel" aria-labelledby="matrix-ap-accounts-title">
      <div className="matrix-ap-panel-head">
        <div>
          <span className="matrix-ap-eyebrow">Authentication</span>
          <h3 id="matrix-ap-accounts-title">Accounts</h3>
        </div>
        <button
          type="button"
          className="matrix-ap-button"
          disabled={disabled || !canLogin}
          onClick={() => setShowLoginMethods((open) => !open)}
          title={canLogin ? undefined : "Adding accounts is not available"}
        >
          + Add account
        </button>
      </div>

      {showLoginMethods ? (
        <div className="matrix-ap-login-methods" aria-label="Login methods">
          {harness.loginMethods.map((method) => (
            <button
              type="button"
              className="matrix-ap-button"
              key={method}
              onClick={() => {
                onMutate({ type: "start_login", harnessInstanceId: harness.id, accountId: null, method });
                setShowLoginMethods(false);
              }}
            >
              {method === harness.recommendedLoginMethod ? "Recommended · " : ""}{titleCase(method)}
            </button>
          ))}
        </div>
      ) : null}

      {attempt ? (
        <div className="matrix-ap-attempt" role="status">
          <span>Authentication {titleCase(attempt.state).toLowerCase()}</span>
          <AttemptAction attempt={attempt} onOpenTerminal={onOpenTerminal} onOpenBrowser={onOpenBrowser} />
        </div>
      ) : null}

      <div className="matrix-ap-account-list">
        {accounts.length === 0 ? (
          <p className="matrix-ap-empty">No provider accounts yet. Matrix gateway can still fund eligible models.</p>
        ) : accounts.map((account) => {
          const source = sources.find((candidate) => candidate.id === account.accessSourceId);
          const usage = source ? usageLines(source.usage) : null;
          const selected = harness.selectedAccountId === account.id;
          return (
            <article className="matrix-ap-account" key={account.id} data-testid={`account-${account.id}`}>
              <div className="matrix-ap-account-main">
                <span className="matrix-ap-avatar" aria-hidden="true">{account.displayName.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{account.displayName}</strong>
                  <span>{authLabel(account.authState)} · {titleCase(account.authMethod)}</span>
                </div>
                {selected ? <span className="matrix-ap-selected-tag">Selected</span> : null}
              </div>
              <div className="matrix-ap-account-usage">
                <strong>{usage?.primary ?? "Usage unavailable"}</strong>
                {usage?.secondary ? <span>{usage.secondary}</span> : null}
                {usage?.stale ? <span>Stale</span> : null}
              </div>
              <div className="matrix-ap-account-actions">
                {account.authState === "authenticated" ? (
                  <button
                    type="button"
                    className="matrix-ap-link-button"
                    disabled={disabled || !canLogout}
                    onClick={() => onMutate({ type: "logout_account", accountId: account.id })}
                    aria-label={`Log out ${account.displayName}`}
                    title={canLogout ? undefined : "Logout is not available"}
                  >Log out</button>
                ) : (
                  <button
                    type="button"
                    className="matrix-ap-link-button"
                    disabled={disabled || !canLogin}
                    onClick={() => onMutate({ type: "start_login", harnessInstanceId: harness.id, accountId: account.id, method: account.authMethod })}
                    aria-label={`Log in ${account.displayName}`}
                    title={canLogin ? undefined : "Login is not available"}
                  >Log in</button>
                )}
                <button
                  type="button"
                  className="matrix-ap-link-button matrix-ap-danger-text"
                  disabled={disabled || (!canRemove && !canReassign)}
                  onClick={() => setRemoveAccount(account)}
                  aria-label={`Remove ${account.displayName}`}
                  title={canRemove || canReassign ? undefined : "Account removal is not available"}
                >Remove</button>
              </div>
            </article>
          );
        })}
      </div>

      {!canLogin || !canLogout || (!canRemove && !canReassign) ? (
        <p className="matrix-ap-help">Some account actions are unavailable in this runtime.</p>
      ) : null}

      {removeAccount ? (
        <RemovalDialog
          account={removeAccount}
          accounts={accounts}
          sources={sources.filter((source) => source.providerId === removeAccount.providerId)}
          disabled={disabled}
          canRemove={canRemove}
          canReassign={canReassign}
          onMutate={onMutate}
          onClose={() => setRemoveAccount(null)}
        />
      ) : null}
    </section>
  );
}
