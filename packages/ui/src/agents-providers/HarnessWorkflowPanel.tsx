import { isCodexDeviceOption, isCodexExistingAccountOption, isCodexTerminalOption } from "./managed-connection-capability.js";
import { WorkflowConnectionChooser } from "./WorkflowConnectionChooser.js";
import { ConnectionMethodCard } from "./ConnectionMethodCard.js";
import { useHarnessWorkflowController, type HarnessWorkflowPanelProps } from "./use-harness-workflow-controller.js";
import { WorkflowKeyForm, WorkflowLoginProgress, WorkflowFailure, WorkflowDisconnectDialog } from "./WorkflowOperationViews.js";
const active = (operation: import("@matrix-os/contracts").ProviderWorkflow | null) => operation?.state === "pending" || operation?.state === "running";

export function HarnessWorkflowPanel(props: HarnessWorkflowPanelProps) {
  const state = useHarnessWorkflowController(props);
  const terminalAvailable = props.terminalAvailable ?? true;
  const { source } = state;
  const { harness, capability, client, disabled, onRefresh, onOpenTerminal, onConnectSaved, connectSavedDisabled, onDisconnect, operationId, onOperationId, renderConnection, renderAccountActions, advancedConfiguration, operation, setOperation, method, setMethod, pending, startingLogin, reconciling, refreshAfterLogin, failure, setFailure, connected, connectionPresent, setDisconnectOpen, setUninstall, connectionPanel, pendingStart: pendingStartRef, run, start, stopPolling, restartPolling, failed, connecting, reuseCodex, inlineLogin, hasSubscription, subscriptionName } = state;
  const codexTerminal = harness.harness === "codex" && capability.connectionOptions?.some(isCodexTerminalOption);
  const codexDevice = harness.harness === "codex" && capability.connectionOptions?.some(isCodexDeviceOption);
  const existingCodexAccount = harness.harness === "codex" ? capability.connectionOptions?.find(isCodexExistingAccountOption) : undefined;
  const reconnectOption = harness.harness === "codex" && source?.fundingKind === "owner_account"
    ? existingCodexAccount ?? capability.connectionOptions?.find(isCodexDeviceOption) ?? capability.connectionOptions?.find(isCodexTerminalOption) : undefined;
  const reconnectExistingCodex = reconnectOption?.method === "existing_codex";
  const recoveringCodexSignIn = state.existingCodexVerificationFailed;
  const codexFallbackOptions = recoveringCodexSignIn
    ? capability.connectionOptions?.filter(option => isCodexDeviceOption(option) || (terminalAvailable && isCodexTerminalOption(option)))
    : undefined;
  const codexDeviceOperation = codexDevice && isCodexDeviceOption(operation?.connectionOption);
  const codexTerminalOperation = codexTerminal && isCodexTerminalOption(operation?.connectionOption);
  const existingCodexOperation = harness.harness === "codex" && isCodexExistingAccountOption(operation?.connectionOption);
  const existingCodexStartFailure = !operation && existingCodexAccount && isCodexExistingAccountOption(state.selectedOption);
  const showCodexLoginProgress = codexDeviceOperation || codexTerminalOperation || existingCodexOperation
    || !operation && (codexDevice || codexTerminal || existingCodexAccount);
  const terminalOnly = !capability.connectionOptions && capability.loginMethods.includes("terminal") && !inlineLogin;
  const adoptOption = props.availableClaudeAccount && harness.harness === "claude" && client.startConnection
    ? capability.connectionOptions?.find(option => option.providerId === "anthropic" && option.authKind === "subscription"
      && option.executionKind === "native" && option.billingKind === "subscription" && option.availability === "available"
      && (option.method === "browser" || option.method === "terminal")) : undefined;
  const showConnectionChoices = harness.harness === "codex"
    ? !connectionPresent && (recoveringCodexSignIn || !onConnectSaved || (failed && !existingCodexOperation && !reconnectExistingCodex))
    : !adoptOption && (!connectionPresent || method !== null || failed);
  const canChangeAccount = capability.connectionOptions
    ? capability.connectionOptions.some(option => option.availability === "available" && (option.authKind === "api_key" ? Boolean(client.submitConnectionKey) : Boolean(client.startConnection)))
    : inlineLogin || terminalOnly || (capability.apiKeyProviders.length > 0 && Boolean(client.submitKey));
  const changeAccountAction =
    harness.harness !== "codex" && connected &&
    canChangeAccount ? (
      <button
        type="button"
        className="matrix-ap-button"
        disabled={disabled || pending || connecting || reconciling}
        onClick={() =>
          setMethod(inlineLogin || terminalOnly ? "account" : "key")
        }
      >
        Change account
      </button>
    ) : null;

  const accountActions = renderAccountActions?.(disabled || pending || connecting || reconciling
    || (operationId !== null && operation?.id !== operationId));
  // Codex has one primary action per state: Reconnect only while its saved login needs sign-in.
  const savedConnectionAction = onConnectSaved && !connected && (!recoveringCodexSignIn || reconnectExistingCodex) ? <button type="button"
    className={harness.harness === "codex" ? "matrix-ap-button matrix-ap-button-primary" : "matrix-ap-button"}
    disabled={disabled || connectSavedDisabled || pending || connecting || reconciling || (harness.harness === "codex" && operationId !== null && operation?.id !== operationId)}
    onClick={() => reconnectOption ? void start("login", reconnectOption.method === "terminal", reconnectOption) : void run(onConnectSaved)}>{reconnectExistingCodex ? "Use existing Codex account" : harness.harness === "codex" ? "Reconnect" : "Connect saved connection"}</button> : null;
  const refreshExistingCodexAccount = !onConnectSaved ? <button type="button" className="matrix-ap-button"
    disabled={disabled || pending} onClick={onRefresh}>Check again</button> : null;

  return (
    <section
      ref={connectionPanel}
      className="matrix-ap-workflow matrix-ap-harness-workflow"
      aria-label={`${harness.displayName} connection`}
      aria-busy={reconciling || (pending && !startingLogin)}
    >
      {harness.installState === "installed" && (connectionPresent || props.availableClaudeAccount) ? renderConnection?.(changeAccountAction) : null}
      {adoptOption ? <>
        <p className="matrix-ap-help">Use your signed-in Claude account for this agent. Uses your Claude subscription; Matrix AI credit is separate.</p>
        <button type="button" className="matrix-ap-button" disabled={disabled || pending || connecting || reconciling
          || (operationId !== null && operation?.id !== operationId)}
          onClick={() => void start("login", adoptOption.method === "terminal", adoptOption)}>Use connected Claude account</button>
      </> : null}
      {harness.harness === "codex" && (savedConnectionAction || accountActions)
        ? <div className="matrix-ap-workflow-actions" role="group" aria-label="Codex connection actions">{savedConnectionAction}{accountActions}</div>
        : <>{accountActions}{savedConnectionAction}</>}
      {harness.installState === "installed" && !connectionPresent
        && !capability.connectionOptions && !inlineLogin && !terminalOnly && capability.apiKeyProviders.length === 0 ? (
        <p className="matrix-ap-help" role="status">
          Connection in Settings is unavailable for this agent on this computer.
        </p>
      ) : null}
      {terminalOnly && harness.installState === "installed" && (showConnectionChoices || connecting) ? (
        <div className="matrix-ap-workflow-actions">
            <button type="button" className="matrix-ap-button" disabled={disabled || pending || connecting || reconciling}
              onClick={() => void start("login", true)}>Log in in Terminal</button>
          {(harness.harness === "codex" ? state.canContinueInTerminal : connecting && !failure) && operation?.kind === "login" && operation.terminalSessionId ? (
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
          <fieldset disabled={disabled || pending || connecting || reconciling} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{advancedConfiguration}</fieldset>
        </details>
      ) : null}
      {failure && (existingCodexStartFailure ? (
        <div role="alert" className="matrix-ap-notice" data-tone="danger">
          <span>{failure}</span>
          {refreshExistingCodexAccount}
        </div>
      ) : (
        <p role="alert" className="matrix-ap-notice" data-tone="danger">{failure}</p>
      ))}
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
                {terminalAvailable ? "The installation runs in Terminal." : "This takes a minute or two. You can keep going; it finishes in the background."}
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
              <span>{harness.harness === "codex" ? "Sign-in expired. Check your connection to continue." : "Sign-in expired. Reconnect to continue."}</span>
              {inlineLogin && !existingCodexAccount && !recoveringCodexSignIn ? (
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
          {capability.connectionOptions ? (showConnectionChoices ? <WorkflowConnectionChooser state={state} codexFallbackOptions={codexFallbackOptions} /> : null) : (inlineLogin ||
            capability.apiKeyProviders.length > 0) &&
          showConnectionChoices ? (
            <div className="matrix-ap-login-choices">
              <h3>Connect {harness.displayName} with</h3>
              <div className="matrix-ap-connection-options">
                {inlineLogin ? (
                  <ConnectionMethodCard
                    method="account"
                    title={reuseCodex ? "Use existing Codex account" : hasSubscription ? `${subscriptionName} account` : "Provider account"}
                    description={reuseCodex ? "Use the ChatGPT account connected on this computer" : hasSubscription ? `Use your ${subscriptionName} plan` : "Connect your provider account"}
                    recommended={hasSubscription}
                    selected={method === "account"}
                    loading={startingLogin}
                    disabled={disabled || pending || connecting || reconciling}
                    onClick={() => void start("login")}
                  />
                ) : null}
                {capability.apiKeyProviders.length ? (
                  <ConnectionMethodCard
                    method="key"
                    title="API key"
                    description={`Pay ${harness.harness === "codex" ? "OpenAI" : "your provider"} per request`}
                    selected={method === "key"}
                    disabled={disabled || pending || connecting || reconciling}
                    onClick={() => {
                      pendingStartRef.current = null;
                      setMethod("key");
                      setOperation(null);
                      setFailure(null);
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
      <WorkflowKeyForm state={state} />
      {harness.harness === "claude" || showCodexLoginProgress ? <WorkflowLoginProgress state={state} /> : null}
        </>
      )}
      <WorkflowFailure state={state} canRetryLogin={harness.harness === "claude" || !recoveringCodexSignIn && !existingCodexAccount && Boolean(codexTerminalOperation || codexDeviceOperation)} />
      <div className="matrix-ap-workflow-actions">
        {failure && (connecting || operation?.state === "succeeded") ? (
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
                  if (next.state === "succeeded") {
                    if (next.kind === "login") void refreshAfterLogin(next);
                    else onRefresh();
                  }
                }
              }, "status")
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
                    pendingStartRef.current = null;
                    onOperationId?.(null);
                    if (result.kind === "login" && result.state === "succeeded") void refreshAfterLogin(result);
                    else if (result.kind !== "login") onRefresh();
                  }
                }
              })
            }
          >
            Cancel
          </button>
        ) : null}
        {terminalAvailable && operation?.terminalSessionId && (operation.kind !== "login" || (harness.harness === "codex" ? state.canContinueInTerminal && codexTerminalOperation : active(operation) && ["claude", "hermes"].includes(harness.harness) && operation.connectionOption?.method === "terminal")) ? (
          <button
            type="button"
            className="matrix-ap-link-button"
            disabled={harness.harness === "codex" && (disabled || pending)}
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
            disabled={disabled || pending || connecting || reconciling || !onDisconnect}
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
