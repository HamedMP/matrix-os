import { WorkflowConnectionChooser } from "./WorkflowConnectionChooser.js";
import { ConnectionMethodCard } from "./ConnectionMethodCard.js";
import { useHarnessWorkflowController, type HarnessWorkflowPanelProps } from "./use-harness-workflow-controller.js";
import { WorkflowKeyForm, WorkflowLoginProgress, WorkflowDisconnectDialog } from "./WorkflowOperationViews.js";
const active = (operation: import("@matrix-os/contracts").ProviderWorkflow | null) => operation?.state === "pending" || operation?.state === "running";

export function HarnessWorkflowPanel(props: HarnessWorkflowPanelProps) {
  const state = useHarnessWorkflowController(props);
  const { harness, capability, client, disabled, onRefresh, onOpenTerminal, onConnectSaved, connectSavedDisabled, onDisconnect, operationId, onOperationId, renderConnection, renderAccountActions, advancedConfiguration, operation, setOperation, method, setMethod, pending, failure, setFailure, connected, setDisconnectOpen, uninstall, setUninstall, connectionPanel, pendingStart, run, start, stopPolling, restartPolling, failed, connecting, reuseCodex, inlineLogin, hasSubscription, subscriptionName, back } = state;
  const terminalOnly = !capability.connectionOptions && capability.loginMethods.includes("terminal") && !inlineLogin;
  const canChangeAccount = capability.connectionOptions
    ? capability.connectionOptions.some(option => option.availability === "available" && (option.authKind === "api_key" ? Boolean(client.submitConnectionKey) : Boolean(client.startConnection)))
    : inlineLogin || terminalOnly || (capability.apiKeyProviders.length > 0 && Boolean(client.submitKey));
  const changeAccountAction =
    connected &&
    canChangeAccount ? (
      <button
        type="button"
        className="matrix-ap-button"
        disabled={disabled || pending || connecting}
        onClick={() =>
          setMethod(inlineLogin || terminalOnly ? "account" : "key")
        }
      >
        Change account
      </button>
    ) : null;

  return (
    <section
      ref={connectionPanel}
      className="matrix-ap-workflow"
      aria-label={`${harness.displayName} connection`}
      aria-busy={pending}
    >
      {harness.installState === "installed" && connected ? renderConnection?.(changeAccountAction) : null}
      {renderAccountActions?.(disabled || pending || connecting
        || (operationId !== null && operation?.id !== operationId))}
      {onConnectSaved && !connected ? <button type="button" className="matrix-ap-button"
        disabled={disabled || connectSavedDisabled || pending || connecting} onClick={() => void run(onConnectSaved)}>Connect saved connection</button> : null}
      {harness.installState === "installed" && !connected
        && !capability.connectionOptions && !inlineLogin && !terminalOnly && capability.apiKeyProviders.length === 0 ? (
        <p className="matrix-ap-help" role="status">
          Connection in Settings is unavailable for this agent on this computer.
        </p>
      ) : null}
      {terminalOnly && harness.installState === "installed" && (!connected || method !== null || failed || connecting) ? (
        <div className="matrix-ap-workflow-actions">
            <button type="button" className="matrix-ap-button" disabled={disabled || pending || connecting}
              onClick={() => void start("login", true)}>Log in in Terminal</button>
          {connecting && !failure && operation?.kind === "login" && operation.terminalSessionId ? (
            <button type="button" className="matrix-ap-button" disabled={disabled || pending}
              onClick={() => void run(async () => { onOpenTerminal(operation.terminalSessionId!); })}>
              Continue in Terminal
            </button>
          ) : null}
        </div>
      ) : null}
      {advancedConfiguration ? (
        <details className="matrix-ap-advanced">
          <summary>Advanced configuration</summary>
          <fieldset disabled={disabled || pending || connecting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{advancedConfiguration}</fieldset>
        </details>
      ) : null}
      {failure ? (
        <p role="alert" className="matrix-ap-notice" data-tone="danger">
          {failure}
        </p>
      ) : null}
      {harness.installState === "unknown" || (harness.installState === "failed" && !capability.install) ? (
        <div className="matrix-ap-install">
          <p className="matrix-ap-help">Installation status is unavailable. Check again.</p>
          <button type="button" className="matrix-ap-button" disabled={disabled || pending} onClick={onRefresh}>Check again</button>
        </div>
      ) : harness.installState === "missing" ||
      harness.installState === "installing" ||
      (harness.installState === "failed" && capability.install) ||
      (operation?.kind === "install" && active(operation)) ? (
        <div className="matrix-ap-install">
          {connecting ? (
            <>
              <p>Installing {harness.displayName}…</p>
              <progress aria-label={`Installing ${harness.displayName}`} />
              <p className="matrix-ap-help">
                The installation runs in Terminal.
              </p>
            </>
          ) : (
            <p className="matrix-ap-help">
              Not on this computer yet. Install it to get started.
            </p>
          )}
          {capability.install && !connecting ? (
            <button
              type="button"
              className="matrix-ap-button matrix-ap-button-primary"
              disabled={disabled || pending}
              onClick={() => void start("install")}
            >
              Install
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {harness.authState === "expired" && !connecting ? (
            <div className="matrix-ap-notice" data-tone="warning">
              <span>{harness.harness === "codex" ? "Connection expired. Connect with a supported API key to continue." : "Sign-in expired. Reconnect to continue."}</span>
              {inlineLogin ? (
                <button
                  type="button"
                  className="matrix-ap-button"
                  disabled={disabled || pending}
                  onClick={() => capability.connectionOptions ? setMethod("account") : void start("login")}
                >
                  Reconnect
                </button>
              ) : null}
            </div>
          ) : null}
          {capability.connectionOptions ? ((!connected || method !== null || failed) ? <WorkflowConnectionChooser state={state} /> : null) : (inlineLogin ||
            capability.apiKeyProviders.length > 0) &&
          (!connected ||
            method !== null ||
            failed) ? (
            <>
              <h3>Connect {harness.displayName} with</h3>
              <div className="matrix-ap-connection-options">
                {inlineLogin ? (
                  <ConnectionMethodCard
                    method="account"
                    title={reuseCodex ? "Use existing Codex account" : hasSubscription ? `${subscriptionName} account` : "Provider account"}
                    description={reuseCodex ? "Use the ChatGPT account connected on this computer" : hasSubscription ? `Use your ${subscriptionName} plan` : "Connect your provider account"}
                    recommended={hasSubscription}
                    selected={method === "account"}
                    disabled={disabled || pending || connecting}
                    onClick={() => void start("login")}
                  />
                ) : null}
                {capability.apiKeyProviders.length ? (
                  <ConnectionMethodCard
                    method="key"
                    title="API key"
                    description={`Pay ${harness.harness === "codex" ? "OpenAI" : "your provider"} per request`}
                    selected={method === "key"}
                    disabled={disabled || pending || connecting}
                    onClick={() => {
                      pendingStart.current = null;
                      setMethod("key");
                      setOperation(null);
                      setFailure(null);
                    }}
                  />
                ) : null}
              </div>
            </>
          ) : null}
      <WorkflowKeyForm state={state} />
      {harness.harness === "claude" ? <WorkflowLoginProgress state={state} /> : null}
        </>
      )}
      {failed && operation ? (
        <div className="matrix-ap-notice" data-tone="danger" role="alert">
          <span>
            {operation.state === "expired"
              ? "The sign-in code expired."
              : operation.kind === "install"
                ? "Installation couldn't complete. Try again."
                : operation.kind === "uninstall"
                  ? "Uninstall couldn't complete. Try again."
                  : "Couldn't connect. Try again."}
          </span>
          {!(harness.harness !== "claude" && operation.kind === "login") ? <button
            type="button"
            className="matrix-ap-button"
            disabled={disabled || pending}
            onClick={() => void start(operation.kind)}
          >
            Try again
          </button> : null}
          <button type="button" className="matrix-ap-button" onClick={back}>
            {operation.kind === "login" ? "Choose another way" : "Back"}
          </button>
        </div>
      ) : null}
      <div className="matrix-ap-workflow-actions">
        {failure && connecting ? (
          <button
            type="button"
            className="matrix-ap-button"
            disabled={pending || disabled}
            onClick={() =>
              void run(async (signal) => {
                const next = await client.get(operation!.id, signal);
                if (
                  next.id !== operation!.id ||
                  next.harnessInstanceId !== harness.id ||
                  next.kind !== operation!.kind
                )
                  throw new Error("workflow scope mismatch");
                if (!signal.aborted) {
                  setOperation(next);
                  setFailure(null);
                  if (active(next)) restartPolling();
                  if (next.state === "succeeded") onRefresh();
                }
              })
            }
          >
            Check connection
          </button>
        ) : null}
        {connecting && operation?.kind !== "uninstall" ? (
          <button
            type="button"
            className="matrix-ap-button"
            disabled={pending || disabled}
            onClick={() =>
              void run(async (signal) => {
                stopPolling();
                const result = await client.cancel(operation!.id, signal);
                if (
                  result.id !== operation!.id ||
                  result.harnessInstanceId !== harness.id
                )
                  throw new Error("workflow scope mismatch");
                if (!signal.aborted) {
                  setOperation(result);
                  if (["cancelled", "succeeded"].includes(result.state)) {
                    pendingStart.current = null;
                    onOperationId?.(null);
                    onRefresh();
                  }
                }
              })
            }
          >
            Cancel
          </button>
        ) : null}
        {operation?.terminalSessionId && (operation.kind !== "login" || (active(operation) && harness.harness === "claude" && operation.connectionOption?.method === "terminal")) ? (
          <button
            type="button"
            className="matrix-ap-link-button"
            onClick={() =>
              void run(async () => {
                onOpenTerminal(operation.terminalSessionId!);
              })
            }
          >
            Continue in Terminal
          </button>
        ) : null}
        {connected && onDisconnect ? (
          <button
            type="button"
            className="matrix-ap-link-button"
            disabled={disabled || pending || connecting || !onDisconnect}
            onClick={() => {
              setDisconnectOpen(true);
              setUninstall(false);
            }}
          >
            Disconnect
          </button>
        ) : null}
        {!renderConnection ? changeAccountAction : null}
      </div>
      <WorkflowDisconnectDialog state={state} />
    </section>
  );
}
