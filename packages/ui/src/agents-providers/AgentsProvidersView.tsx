import {BotUseAuthorizationPanel} from "./BotUseAuthorizationPanel.js";
import type { ProviderWorkflowUICapability } from "./types.js";
import { HarnessWorkflowPanel } from "./HarnessWorkflowPanel.js";
import { ProviderWorkflowClientError } from "./provider-workflow-client.js";
import { hasConfiguredConnection, resolveHarnessConnection, isNativeAccountSource } from "./harness-connection.js";
import { updateWorkflowRowStatus } from "./workflow-row-status.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { RetainedHarnessAction } from "./RetainedHarnessAction.js";
import { AccountsPanel } from "./AccountsPanel.js";
import { AccountLifecycleActions } from "./AccountLifecycleActions.js";
import { AddHarnessDialog } from "./AddHarnessDialog.js";
import { GatewayPanel } from "./GatewayPanel.js";
import { YourSubscriptions } from "./YourSubscriptions.js";
import { managedConnectionCapability } from "./managed-connection-capability.js";
import { UsageHistoryDialog } from "./UsageHistoryDialog.js";
import { useHarnessEnablement } from "./use-harness-enablement.js";
import { ConnectedAccountCard } from "./ConnectedAccountCard.js";
import { CatalogSetupPanel } from "./CatalogSetupPanel.js";
import { ConnectionFallback } from "./ConnectionFallback.js";
import { useGatewaySelection } from "./use-gateway-selection.js";
import { HarnessEditor } from "./HarnessEditor.js";
import { HarnessRail } from "./HarnessRail.js";
import { ConnectionChoices } from "./ConnectionChoices.js";
import { settingsErrorPresentation } from "./settings-error-presentation.js";
import type { AgentsProvidersViewProps, ProviderSettingsMutationIntent } from "./types.js";
import { relativeCheckedAt, selectedHarness, titleCase } from "./utils.js";

export type { AgentsProvidersViewProps, ProviderSettingsMutationIntent } from "./types.js";

type SupportedAction = ProviderSettingsMutationIntent["type"] | "add_credit" | "submit_api_key";

function supportedActions(snapshot: ProviderSettingsSnapshot): readonly SupportedAction[] {
  return (snapshot as ProviderSettingsSnapshot & { supportedActions?: readonly SupportedAction[] }).supportedActions ?? [];
}

export function AgentsProvidersView({
  snapshot,
  selectedHarnessId,
  connectionAttempt = null,
  busy = false,
  error = null,
  onSelectHarness,
  onRefresh,
  onRefreshForConnection,
  onMutate,
  onOpenTerminal,
  onOpenBrowser,
  onAddCredit,
  onSetupHarness,
  workflowClient,
  onOpenAuthorizationUrl,
  onLoadUsageHistory,
}: AgentsProvidersViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const [subscriptionTarget, setSubscriptionTarget] = useState<string | null>(null);
  const [historyLoader, setHistoryLoader] = useState<AgentsProvidersViewProps["onLoadUsageHistory"]>(undefined);
  const [workflowCapabilities, setWorkflowCapabilities] = useState<ProviderWorkflowUICapability[]>([]);
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
  const [workflowStatus, setWorkflowStatus] = useState<Record<string, string>>({});
  const [workflowPermission, setWorkflowPermission] = useState<"unknown" | "available" | "forbidden">("unknown");
  const [stateClient, setStateClient] = useState(workflowClient);
  useEffect(() => {
    if (!workflowClient) return;
    const controller = new AbortController();
    void workflowClient.capabilities(controller.signal).then(value => {
      if (!controller.signal.aborted) {setWorkflowCapabilities(value.map(managedConnectionCapability)); setWorkflowPermission("available");}
    }).catch(caught => {
      if (controller.signal.aborted) return;
      console.warn("[provider-settings] Workflow capabilities unavailable:", caught instanceof Error ? caught.name : typeof caught);
      setWorkflowCapabilities([]);
      setWorkflowPermission(caught instanceof ProviderWorkflowClientError && caught.reason === "forbidden" ? "forbidden" : "unknown");
      // An owner denial is not evidence that the Matrix login expired.
      if (caught instanceof ProviderWorkflowClientError && caught.reason === "forbidden") return;
    });
    return () => controller.abort();
  }, [workflowClient, snapshot.refreshedAt]);
  const rememberOperation = (id: string, operation: string | null) => setOperationIds(current => {
    const next = { ...current };
    if (operation === null) delete next[id];
    else if (id in next || Object.keys(next).length < 32) next[id] = operation;
    return next;
  });
  const [addOpen, setAddOpen] = useState(false);
  const [connectRequests, setConnectRequests] = useState<Record<string, number>>({});
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [expandedRowKind, setExpandedRowKind] = useState<ProviderWorkflowUICapability["harness"] | null>(null);
  if (stateClient !== workflowClient) {
    setStateClient(workflowClient); setWorkflowCapabilities([]); setOperationIds({}); setWorkflowStatus({}); setHistoryLoader(undefined); setConnectRequests({}); setExpandedRowId(null); setExpandedRowKind(null); setWorkflowPermission("unknown"); setSubscriptionTarget(null);
  }
  const inventoryHarnesses = workflowCapabilities.filter(
    (item) =>
      !snapshot.harnesses.some((harness) => harness.harness === item.harness),
  );
  // An install/refresh can replace a catalog row with a workflow or saved ID.
  // Keep the user's disclosure open for that agent rather than collapsing the page.
  const rowIdentities = [
    ...snapshot.harnesses.map(item => ({ id: item.id, harness: item.harness })),
    ...inventoryHarnesses.map(item => ({ id: item.harnessInstanceId, harness: item.harness })),
    ...(snapshot.harnessCatalog ?? []).filter(item => !snapshot.harnesses.some(row => row.harness === item.harness) && !inventoryHarnesses.some(row => row.harness === item.harness)).map(item => ({ id: `catalog:${item.harness}`, harness: item.harness })),
  ];
  const requestConnect = async (id: string): Promise<boolean> => {
    // Keep current rows' counters intact: resetting them can reopen a live chooser.
    // Removed IDs must not exhaust admission after an install/catalog refresh.
    const currentIds = rowIdentities.map(item => item.id);
    if (!currentIds.includes(id)) return false;
    const retained = Object.fromEntries(Object.entries(connectRequests).filter(([key]) => currentIds.includes(key)));
    if (!(id in retained) && Object.keys(retained).length >= 32) return false;
    setConnectRequests({ ...retained, [id]: (retained[id] ?? 0) + 1 });
    return true;
  };
  const resolvedExpandedId = expandedRowId === null ? null
    : rowIdentities.some(item => item.id === expandedRowId) ? expandedRowId
    : rowIdentities.find(item => item.harness === expandedRowKind)?.id ?? null;
  useEffect(() => {
    if (!subscriptionTarget || resolvedExpandedId !== subscriptionTarget) return;
    const trigger = root.current?.ownerDocument.getElementById(`matrix-ap-details-${subscriptionTarget}-trigger`);
    if (trigger && root.current?.contains(trigger)) {
      trigger.scrollIntoView?.({block: "nearest"});
      trigger.focus({preventScroll: true});
    }
    setSubscriptionTarget(null);
  }, [subscriptionTarget, resolvedExpandedId]);

  const harness = selectedHarness(snapshot, selectedHarnessId);
  const actions = supportedActions(snapshot);
  const supports = (action: SupportedAction) => actions.includes(action);
  const readOnly = snapshot.access.mode === "read_only";
  const selectedId = harness?.id ?? null;
  const configurationHarnessKinds = snapshot.configurationHarnessKinds ?? [];
  const { gatewayPending, gatewayError, genericConfiguration, gatewaySource, gatewayProvider, gatewayModel,
    gatewaySelected, compatibleGatewayAgents, useGateway } = useGatewaySelection({snapshot, harness,
      selectedId, disabled: busy || readOnly, supports, onMutate});
  const enablement = useHarnessEnablement({ snapshot, refresh: onRefreshForConnection, mutate: onMutate, scope: workflowClient });
  const visibleError = error ?? enablement.error;
  const refreshSettings = () => { enablement.clearError(); onRefresh(); };
  const mutationsDisabled = busy || readOnly || gatewayPending || enablement.pending;
  const errorPresentation = settingsErrorPresentation(gatewayError ? null : visibleError);

  return (
    <div ref={root} className="matrix-agents-providers" aria-busy={busy || gatewayPending ? "true" : undefined}>
      <header className="matrix-ap-page-head">
        <div>
          <span className="matrix-ap-eyebrow">Settings</span>
          <h1>Agents &amp; providers</h1>
          <p>Connect an agent, choose a model, and start a chat.</p>
        </div>
        <div className="matrix-ap-refresh">
          <span>Checked {relativeCheckedAt(snapshot.refreshedAt)}</span>
          {supports("add_harness") && configurationHarnessKinds.length > 0 ? (
            <button type="button" className="matrix-ap-icon-button" aria-label="Add agent" title="Add agent" onClick={() => setAddOpen(true)} disabled={mutationsDisabled}>+</button>
          ) : null}
          <button type="button" className="matrix-ap-icon-button" aria-label="Refresh provider status" onClick={refreshSettings} disabled={busy}>↻</button>
        </div>
      </header>

      {snapshot.access.mode === "read_only" ? (
        <div className="matrix-ap-notice" data-tone="neutral" role="status">
          <strong>Read only</strong>
          <span>{snapshot.access.reason === "remote_policy" ? "Your organization controls these settings." : `Changes are unavailable: ${titleCase(snapshot.access.reason).toLowerCase()}.`}</span>
        </div>
      ) : null}
      {visibleError || gatewayError ? (
        <div className="matrix-ap-notice" data-tone="danger" role="alert">
          <strong>{errorPresentation.title}</strong>
          <span>{errorPresentation.message}</span>
        </div>
      ) : null}

      {historyLoader && historyLoader === onLoadUsageHistory ? <UsageHistoryDialog load={historyLoader} onClose={() => setHistoryLoader(undefined)} /> : null}
      <div className="matrix-ap-workspace">
        <GatewayPanel
          key={gatewaySource?.id ?? "matrix-ai-unconfigured"}
          source={gatewaySource} policy={snapshot.gatewayPolicy} provider={gatewayProvider}
          modelInventory={snapshot.matrixModelInventory}
          onUsageHistory={onLoadUsageHistory ? () => setHistoryLoader(() => onLoadUsageHistory) : undefined}
          disabled={mutationsDisabled} canSetBudget={supports("set_gateway_budget")}
          canSetAllowlist={supports("set_gateway_allowlist")} canAddCredit={supports("add_credit")}
          onMutate={onMutate} onAddCredit={onAddCredit} onRefresh={refreshSettings}
          selectedAgentName={harness?.displayName ?? null}
          selectedAgentEnabled={harness?.enabled ?? false}
          selectedModelName={gatewayModel?.displayName ?? null}
          isSelected={gatewaySelected}
          savedRouteUnavailable={gatewaySource !== null && harness?.accessSourceId === gatewaySource.id && !gatewaySelected}
          compatibleAgents={compatibleGatewayAgents}
          onChooseAgent={(id) => { setExpandedRowId(id); setExpandedRowKind(snapshot.harnesses.find(item => item.id === id)?.harness ?? null); onSelectHarness(id); }}
          onUseGateway={useGateway}
          subscriptions={<YourSubscriptions snapshot={snapshot} capabilities={workflowCapabilities} client={workflowClient}
            operationIds={operationIds} workflowStatus={workflowStatus} forbidden={workflowPermission === "forbidden"}
            disabled={busy || gatewayPending || enablement.pending} onRefresh={refreshSettings}
            onOpen={(id, kind) => { setExpandedRowId(id); setExpandedRowKind(kind); setSubscriptionTarget(id); if (snapshot.harnesses.some(item => item.id === id)) onSelectHarness(id); }} />}
        />
        <HarnessRail
          harnesses={snapshot.harnesses}
          inventory={inventoryHarnesses}
          catalog={(snapshot.harnessCatalog ?? []).filter((entry) => !snapshot.harnesses.some((item) => item.harness === entry.harness) && !inventoryHarnesses.some((item) => item.harness === entry.harness))}
          renderCatalog={(entry) => <CatalogSetupPanel entry={entry} disabled={mutationsDisabled} onSetupHarness={onSetupHarness} onRefresh={refreshSettings} />}
          renderInventory={(item) =>
            workflowClient ? (
              <HarnessWorkflowPanel
                harness={{
                  id: item.harnessInstanceId,
                  harness: item.harness,
                  displayName: item.displayName,
                  installState: item.installState,
                  authState: "unknown",
                }}
                capability={item}
                operationId={
                  operationIds[item.harnessInstanceId] ??
                  item.activeOperationId ??
                  null
                }
                onOperationId={(id) =>
                  rememberOperation(item.harnessInstanceId, id)
                }
                client={workflowClient}
                disabled={mutationsDisabled}
                onSetupHarness={onSetupHarness}
                onRefresh={refreshSettings}
                onOpenTerminal={onOpenTerminal}
                onOpenAuthorizationUrl={onOpenAuthorizationUrl}
                onStateChange={(status) =>
                  setWorkflowStatus(current => updateWorkflowRowStatus(current, item.harnessInstanceId, status))
                }
              />
            ) : null
          }
          sources={snapshot.accessSources}
          accounts={snapshot.accounts}
          statusOverride={workflowStatus}
          selectedId={resolvedExpandedId}
          disabled={mutationsDisabled}
          canEnable={(item) =>
            configurationHarnessKinds.includes(item.harness) &&
            supports("set_harness_enabled")
          }
          canRefreshEnable={onRefreshForConnection !== undefined}
          onEnable={(item) => { void enablement.enable(item); }}
          onSelect={(id) => {
            setExpandedRowId(resolvedExpandedId === id ? null : id);
            setExpandedRowKind(resolvedExpandedId === id ? null : rowIdentities.find(item => item.id === id)?.harness ?? null);
            if (snapshot.harnesses.some((item) => item.id === id)) {
              onSelectHarness(id);
            }
          }}
          renderDetails={(harness) => {
            const capability = workflowCapabilities.find(
              (item) => item.harnessInstanceId === harness.id,
            );
            const guided = Boolean(workflowClient && capability);
            const { account: selectedAccount, source } = resolveHarnessConnection(harness, snapshot.accounts, snapshot.accessSources);
            const nativeSource = harness.harness !== "claude" || isNativeAccountSource("claude", source, selectedAccount);
            const allowedSavedConnection = nativeSource && (harness.harness !== "codex" || source?.fundingKind === "owner_api_key" || selectedAccount?.authMethod === "api_key");
            const connected = nativeSource && hasConfiguredConnection(harness, source);
            const catalog = snapshot.harnessCatalog?.find(item => item.harness === harness.harness);
            const connectionCard = (action?: ReactNode) => <ConnectedAccountCard harness={harness} account={selectedAccount} source={source} action={action} disabled={mutationsDisabled} onRefresh={refreshSettings} />;
            return (
              <>
                {workflowClient?.botConnections && harness.harness === "claude" ? <BotUseAuthorizationPanel key={`${harness.id}:bot-use`} client={workflowClient.botConnections} refreshKey={snapshot.refreshedAt} harness={harness.harness} disabled={mutationsDisabled || workflowPermission === "forbidden"} /> : null}
                {!guided ? <ConnectionChoices
                  snapshot={snapshot}
                  harness={harness}
                  gatewaySource={gatewaySource}
                  gatewaySelected={gatewaySelected}
                  onUseGateway={useGateway}
                  canSetRoute={genericConfiguration && supports("set_route")}
                  disabled={mutationsDisabled}
                  onMutate={onMutate}
                  onRefreshForConnection={onRefreshForConnection}
                  onConnectSettings={capability && (capability.loginMethods.some(method => method !== "terminal") || capability.apiKeyProviders.length > 0)
                    ? () => requestConnect(harness.id)
                    : undefined}

                /> : null}
                {!guided && harness.installState === "missing" && harness.harness !== "codex" && harness.harness !== "claude" ? <CatalogSetupPanel
                  entry={catalog ?? { harness: harness.harness as "pi" | "opencode" | "hermes" | "openclaw", displayName: harness.displayName, installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_unavailable" }}
                  disabled={mutationsDisabled} onSetupHarness={onSetupHarness} onRefresh={refreshSettings} /> : null}
                {!guided ? <>{connected ? connectionCard() : <ConnectionFallback harness={harness} source={source} workflowPermission={workflowPermission} disabled={mutationsDisabled} onRefresh={refreshSettings} onSetupHarness={onSetupHarness} />}</> : null}
                {!guided && allowedSavedConnection && (!workflowClient || workflowPermission === "available")
                  && supports("set_harness_enabled") && (harness.configuredEnabled ?? harness.enabled) === false
                  && hasConfiguredConnection({ ...harness, configuredEnabled: true, enabled: true }, source) ?
                  <button type="button" className="matrix-ap-button"
                    disabled={mutationsDisabled || workflowPermission === "forbidden" || !onRefreshForConnection}
                    onClick={() => void enablement.connectSaved(harness)}>Connect saved connection</button> : null}
                {!guided && (harness.configuredEnabled ?? harness.enabled) && supports("set_harness_enabled") ?
                  <RetainedHarnessAction scopeKey={`${harness.harness}:${harness.id}:disconnect`} scopeOwner={workflowClient} label="Disconnect" disabled={mutationsDisabled || workflowPermission === "forbidden"}
                    action={() => onMutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false })}
                    onSuccess={refreshSettings} /> : null}
                {!guided && harness.installState === "installed" ? <details className="matrix-ap-advanced"><summary>Advanced configuration</summary>
                  <HarnessEditor snapshot={snapshot} harness={harness} disabled={mutationsDisabled}
                    canUpdate={genericConfiguration && supports("update_harness")} canSetRoute={genericConfiguration && supports("set_route")}
                    canSelectSource={genericConfiguration && supports("select_access_source")} canSelectAccount={genericConfiguration && supports("select_account")}
                    onMutate={onMutate} onRefresh={refreshSettings} />
                  <AccountsPanel harness={harness} accounts={snapshot.accounts.filter(item => harness.accountIds.includes(item.id))}
                    sources={snapshot.accessSources} allHarnesses={snapshot.harnesses} gatewayPolicy={snapshot.gatewayPolicy}
                    attempt={connectionAttempt?.harnessInstanceId === harness.id ? connectionAttempt : null}
                    disabled={mutationsDisabled} canLogin={workflowPermission !== "forbidden" && supports("start_login")} canLogout={supports("logout_account")} canRemove={supports("remove_account")} canReassign={supports("reassign_account")}
                    onMutate={onMutate} onOpenTerminal={onOpenTerminal} onOpenBrowser={onOpenBrowser} onSetupHarness={onSetupHarness} onRefresh={refreshSettings} />
                </details> : null}
                {workflowClient &&
                workflowCapabilities.find(
                  (item) => item.harnessInstanceId === harness.id,
                ) ? (
                  <HarnessWorkflowPanel
                    key={harness.id}
                    connectRequest={connectRequests[harness.id] ?? 0}
                    advancedConfiguration={genericConfiguration ? <>
                      <ConnectionChoices snapshot={snapshot} harness={harness} gatewaySource={gatewaySource}
                        gatewaySelected={gatewaySelected} onUseGateway={useGateway} canSetRoute={supports("set_route")}
                        disabled={mutationsDisabled} onMutate={onMutate} onRefreshForConnection={onRefreshForConnection}
                        onConnectSettings={capability && (capability.loginMethods.some(method => method !== "terminal") || capability.apiKeyProviders.length > 0)
                          ? () => requestConnect(harness.id) : undefined} />
                      <HarnessEditor snapshot={snapshot} harness={harness} disabled={mutationsDisabled}
                        canUpdate={supports("update_harness")} canSetRoute={supports("set_route")}
                        canSelectSource={supports("select_access_source")} canSelectAccount={supports("select_account")}
                        onMutate={onMutate} onRefresh={refreshSettings} />
                    </> : undefined}
                    renderConnection={connected ? connectionCard : undefined}
                    renderAccountActions={(operationDisabled) => <AccountLifecycleActions
                      accounts={snapshot.accounts.filter(item => harness.accountIds.includes(item.id))}
                      snapshot={snapshot} harnessId={harness.id} scopeOwner={workflowClient}
                      disabled={operationDisabled || workflowPermission === "forbidden"}
                      canLogout={supports("logout_account")} canRemove={supports("remove_account")} canReassign={supports("reassign_account")}
                      onMutate={onMutate} onRefresh={refreshSettings} />}
                    onConnectSaved={allowedSavedConnection && supports("set_harness_enabled") && (harness.configuredEnabled ?? harness.enabled) === false && hasConfiguredConnection({ ...harness, configuredEnabled: true, enabled: true }, source) ? () => enablement.connectSaved(harness) : undefined}
                    connectSavedDisabled={workflowPermission === "forbidden" || !onRefreshForConnection}
                    source={source}
                    harness={harness}
                    capability={
                      workflowCapabilities.find(
                        (item) => item.harnessInstanceId === harness.id,
                      )!
                    }
                    operationId={
                      operationIds[harness.id] ??
                      capability?.activeOperationId ??
                      null
                    }
                    onOperationId={(id) => rememberOperation(harness.id, id)}
                    client={workflowClient}
                    disabled={mutationsDisabled}
                    onSetupHarness={onSetupHarness}
                    onRefresh={refreshSettings}
                    onOpenTerminal={onOpenTerminal}
                    onOpenAuthorizationUrl={onOpenAuthorizationUrl}
                    onStateChange={(status) =>
                      setWorkflowStatus(current => updateWorkflowRowStatus(current, harness.id, status))
                    }
                    onDisconnect={
                      supports("set_harness_enabled")
                        ? async () => {
                            return await onMutate({
                              type: "set_harness_enabled",
                              harnessInstanceId: harness.id,
                              enabled: false,
                            });
                          }
                        : undefined
                    }
                  />
                ) : null}

              </>
            );
          }}
        />
        {snapshot.harnesses.length === 0 && inventoryHarnesses.length === 0 && (snapshot.harnessCatalog?.length ?? 0) === 0 ? (
          <div className="matrix-ap-empty-state">
            <strong>No agents found</strong>
            <span>Use + Add agent above to install or connect an agent.</span>
          </div>
        ) : null}
      </div>

      {addOpen && supports("add_harness") ? (
        <AddHarnessDialog snapshot={snapshot} onMutate={onMutate} onClose={() => setAddOpen(false)} onRefresh={refreshSettings} onSetupHarness={onSetupHarness} busy={busy} error={error} />
      ) : null}
    </div>
  );
}
