import { useState } from "react";
import { isSupportedGenericHarnessCredentialRoute } from "@matrix-os/contracts";
import type {
  ProviderAccount,
  ProviderAccessSource,
  ProviderConnectionAttempt,
  ProviderGatewayPolicy,
  ProviderHarnessInstance,
  ProviderHarnessKind,
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
  allHarnesses,
  gatewayPolicy,
  attempt,
  disabled,
  canLogin,
  canLogout,
  canRemove,
  canReassign,
  onMutate,
  onOpenTerminal,
  onOpenBrowser,
  onSetupHarness,
  onRefresh,
}: {
  harness: ProviderHarnessInstance;
  accounts: ProviderAccount[];
  sources: ProviderAccessSource[];
  allHarnesses: ProviderHarnessInstance[];
  gatewayPolicy: ProviderGatewayPolicy | null;
  attempt: ProviderConnectionAttempt | null;
  disabled: boolean;
  canLogin: boolean;
  canLogout: boolean;
  canRemove: boolean;
  canReassign: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => Promise<boolean> | void;
  onOpenTerminal: (sessionId: string) => void;
  onOpenBrowser: (path: string) => void;
  onSetupHarness?: (harness: ProviderHarnessKind) => Promise<boolean>;
  onRefresh?: () => void;
}) {
  const [removeAccountId, setRemoveAccountId] = useState<string | null>(null);
  const removeAccount = accounts.find((account) => account.id === removeAccountId);
  const [showLoginMethods, setShowLoginMethods] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const supportsLogin = canLogin && harness.loginMethods.length > 0;
  const needsGenericLogin = accounts.length === 0 || accounts.some((account) =>
    account.authState !== "authenticated" && !harness.loginMethods.includes(account.authMethod));
  const attemptMethodSupported = attempt !== null && harness.loginMethods.includes(attempt.method);
  const retryMethod = attemptMethodSupported ? attempt.method : harness.loginMethods.find((method) => method === "terminal");
  const selectedSource = sources.find((source) => source.id === harness.accessSourceId);
  const matrixSelected = selectedSource?.kind === "matrix_gateway";
  const matrixSupported = matrixSelected && isSupportedGenericHarnessCredentialRoute(harness, selectedSource);
  const run = async (action: () => Promise<boolean | void> | void) => {
    setPending(true);
    setActionError(null);
    try {
      if (await action() === false) setActionError("The connection could not be updated. Try again.");
    } catch (caught) {
      console.warn("[provider-settings] Account action failed:", caught instanceof Error ? caught.name : typeof caught);
      setActionError("The connection could not be updated. Try again.");
    } finally { setPending(false); }
  };

  return (
    <section className="matrix-ap-panel" aria-labelledby="matrix-ap-accounts-title">
      <div className="matrix-ap-panel-head">
        <div>
          <span className="matrix-ap-eyebrow">Authentication</span>
          <h3 id="matrix-ap-accounts-title">Connection</h3>
        </div>
        {supportsLogin && needsGenericLogin ? <button
          type="button"
          className="matrix-ap-button"
          disabled={disabled || pending}
          onClick={() => setShowLoginMethods((open) => !open)}
        >
          Sign in
        </button> : null}
      </div>
      {actionError ? <p className="matrix-ap-notice" role="alert">{actionError}</p> : null}

      {showLoginMethods ? (
        <div className="matrix-ap-login-methods" aria-label="Login methods">
          {harness.loginMethods.map((method) => (
            <button
              type="button"
              className="matrix-ap-button"
              key={method}
              disabled={disabled || pending}
              onClick={() => {
                void run(async () => {
                  const saved = await onMutate({ type: "start_login", harnessInstanceId: harness.id, accountId: null, method });
                  if (saved === true) setShowLoginMethods(false);
                  return saved;
                });
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
          {supportsLogin && retryMethod && (attempt.action.kind === "retry" || ["failed", "expired", "denied"].includes(attempt.state)) ? <button type="button" className="matrix-ap-button" disabled={disabled || pending}
            onClick={() => void run(() => onMutate({ type: "start_login", harnessInstanceId: harness.id, accountId: attemptMethodSupported ? attempt.accountId : null, method: retryMethod }))}>Retry sign in</button> : null}
          {onRefresh ? <button type="button" className="matrix-ap-button" disabled={disabled || pending} onClick={onRefresh}>Check connection</button> : null}
        </div>
      ) : null}

      <div className="matrix-ap-account-list">
        {accounts.length === 0 ? (
          <p className="matrix-ap-empty">{matrixSupported
            ? "This agent uses Matrix AI. No provider account is required."
            : matrixSelected ? "Saved Matrix AI access is unavailable for this agent. Choose a supported connection."
              : harness.harness === "hermes" || harness.harness === "openclaw"
                ? "Sign in to this agent with your own provider account using Terminal. Matrix AI funding is not supported for this agent yet."
                : "No connected account. Sign in to this agent or choose an available Matrix AI connection."}</p>
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
                {account.authState === "authenticated" && canLogout && supportsLogin ? (
                  <button
                    type="button"
                    className="matrix-ap-link-button"
                    disabled={disabled || pending}
                    onClick={() => void run(() => onMutate({ type: "logout_account", accountId: account.id }))}
                    aria-label={`Log out ${account.displayName}`}
                    title={canLogout ? undefined : "Logout is not available"}
                  >Log out</button>
                ) : account.authState !== "authenticated" && supportsLogin && harness.loginMethods.includes(account.authMethod) ? (
                  <button
                    type="button"
                    className="matrix-ap-link-button"
                    disabled={disabled || pending}
                    onClick={() => void run(() => onMutate({ type: "start_login", harnessInstanceId: harness.id, accountId: account.id, method: account.authMethod }))}
                    aria-label={`Log in ${account.displayName}`}
                    title={canLogin ? undefined : "Login is not available"}
                  >Log in</button>
                ) : null}
                {canRemove || canReassign ? <button
                  type="button"
                  className="matrix-ap-link-button matrix-ap-danger-text"
                  disabled={disabled || pending}
                  onClick={() => setRemoveAccountId(account.id)}
                  aria-label={`Remove ${account.displayName}`}
                  title={canRemove || canReassign ? undefined : "Account removal is not available"}
                >Remove</button> : null}
              </div>
            </article>
          );
        })}
      </div>

      {!supportsLogin && onSetupHarness ? <button type="button" className="matrix-ap-button" disabled={disabled || pending}
        onClick={() => void run(() => onSetupHarness(harness.harness))}>Open {harness.displayName} setup in Terminal</button> : null}
      <p className="matrix-ap-help">Additional isolated accounts are not supported in this runtime yet. Terminal sign-in changes the agent’s current login.</p>

      {removeAccount ? (
        <RemovalDialog
          key={removeAccount.id}
          account={removeAccount}
          accounts={accounts}
          sources={sources.filter((source) => source.providerId === removeAccount.providerId)}
          harnesses={allHarnesses}
          gatewayPolicy={gatewayPolicy}
          disabled={disabled}
          canRemove={canRemove}
          canReassign={canReassign}
          onMutate={onMutate}
          onClose={() => setRemoveAccountId(null)}
        />
      ) : null}
    </section>
  );
}
