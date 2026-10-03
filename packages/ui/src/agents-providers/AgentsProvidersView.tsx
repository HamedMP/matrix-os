import { useHarnessEnablement } from "./use-harness-enablement.js";
import type { ProviderWorkflowCapability } from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "./HarnessWorkflowPanel.js";
import { ProviderWorkflowClientError } from "./provider-workflow-client.js";
import { hasConfiguredConnection, resolveHarnessConnection } from "./harness-connection.js";
import { updateWorkflowRowStatus } from "./workflow-row-status.js";
import { useEffect, useState, type ReactNode } from "react";
import { type ProviderHarnessInstance, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AccountsPanel } from "./AccountsPanel.js";
import { AddHarnessDialog } from "./AddHarnessDialog.js";
import { GatewayPanel } from "./GatewayPanel.js";
import { UsageHistoryDialog } from "./UsageHistoryDialog.js";
import { useGatewaySelection } from "./use-gateway-selection.js";
import { HarnessEditor } from "./HarnessEditor.js";
import { HarnessRail } from "./HarnessRail.js";
import { ConnectionChoices } from "./ConnectionChoices.js";
import { settingsErrorPresentation } from "./settings-error-presentation.js";
import type { AgentsProvidersViewProps, ProviderSettingsMutationIntent } from "./types.js";
import { relativeCheckedAt, selectedHarness, titleCase, usageLines } from "./utils.js";

export type { AgentsProvidersViewProps, ProviderSettingsMutationIntent } from "./types.js";

type SupportedAction = ProviderSettingsMutationIntent["type"] | "add_credit" | "submit_api_key";

function supportedActions(snapshot: ProviderSettingsSnapshot): readonly SupportedAction[] {
  return (snapshot as ProviderSettingsSnapshot & { supportedActions?: readonly SupportedAction[] }).supportedActions ?? [];
}

function SavedAccounts({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return collapsed ? <details className="matrix-ap-advanced"><summary>Manage saved accounts</summary>{children}</details> : children;
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
  const [historyLoader, setHistoryLoader] = useState<AgentsProvidersViewProps["onLoadUsageHistory"]>(undefined);
  const [workflowCapabilities, setWorkflowCapabilities] = useState<ProviderWorkflowCapability[]>([]);
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
  const [workflowStatus, setWorkflowStatus] = useState<Record<string, string>>({});
  const [stateClient, setStateClient] = useState(workflowClient);
  if (stateClient !== workflowClient) {
    setStateClient(workflowClient); setWorkflowCapabilities([]); setOperationIds({}); setWorkflowStatus({}); setHistoryLoader(undefined);
  }
  useEffect(() => {
    if (!workflowClient) return;
    const controller = new AbortController();
    void workflowClient.capabilities(controller.signal).then(value => {
      if (!controller.signal.aborted) setWorkflowCapabilities(value);
    }).catch(caught => {
      if (controller.signal.aborted) return;
      console.warn("[provider-settings] Workflow capabilities unavailable:", caught instanceof Error ? caught.name : typeof caught);
      setWorkflowCapabilities([]);
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
  const enablement = useHarnessEnablement({ snapshot, refresh: onRefreshForConnection, mutate: onMutate, scope: workflowClient });
  const guidedPanel = (item: Pick<ProviderHarnessInstance, "id" | "harness" | "displayName" | "installState" | "authState"> & Partial<ProviderHarnessInstance>, capability: ProviderWorkflowCapability, advancedConfiguration?: import("react").ReactNode) => {
    if (!workflowClient) return null;
    const exact = snapshot.harnesses.find(row => row.id === item.id);
    const { account, source } = exact ? resolveHarnessConnection(exact, snapshot.accounts, snapshot.accessSources) : { account: undefined, source: undefined };
    const usage = source ? usageLines(source.usage) : null;
    return <HarnessWorkflowPanel harness={item} source={source} capability={capability} client={workflowClient}
      advancedConfiguration={advancedConfiguration} disabled={mutationsDisabled || enablement.pending} operationId={operationIds[item.id] ?? capability.activeOperationId ?? null}
      onOperationId={id => rememberOperation(item.id, id)} onRefresh={onRefresh} onOpenTerminal={onOpenTerminal}
      onOpenAuthorizationUrl={onOpenAuthorizationUrl}
      onStateChange={status => setWorkflowStatus(current => updateWorkflowRowStatus(current, item.id, status))}
      renderConnection={action => <div className="matrix-ap-connected"><h3>Connection</h3>
        <div className="matrix-ap-account"><strong>{account?.displayName ?? source?.displayName ?? item.displayName}</strong>
          {usage ? <span>{usage.primary}{usage.secondary ? ` · ${usage.secondary}` : ""}</span> : null}{action}</div></div>}
      onConnectSaved={exact && supports("set_harness_enabled") && (exact.configuredEnabled ?? exact.enabled) === false && hasConfiguredConnection({ ...exact, configuredEnabled: true, enabled: true }, source) ? () => enablement.connectSaved(exact) : undefined}
      onDisconnect={exact && supports("set_harness_enabled") ? async () => await onMutate({ type: "set_harness_enabled", harnessInstanceId: exact.id, enabled: false }) : undefined} />;
  };
  const [addOpen, setAddOpen] = useState(false);
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const harness = selectedHarness(snapshot, selectedHarnessId);
  const actions = supportedActions(snapshot);
  const supports = (action: SupportedAction) => actions.includes(action);
  const readOnly = snapshot.access.mode === "read_only";
  const selectedId = harness?.id ?? null;
  const configurationHarnessKinds = snapshot.configurationHarnessKinds ?? [];
  const { gatewayPending, gatewayError, genericConfiguration, gatewaySource, gatewayProvider, gatewayModel,
    gatewaySelected, compatibleGatewayAgents, useGateway } = useGatewaySelection({snapshot, harness,
      selectedId, disabled: busy || readOnly, supports, onMutate});
  const mutationsDisabled = busy || readOnly || gatewayPending;
  const errorPresentation = settingsErrorPresentation(gatewayError ? null : error ?? enablement.error);

  return (
    <div className="matrix-agents-providers" aria-busy={busy || gatewayPending ? "true" : undefined}>
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
          <button type="button" className="matrix-ap-icon-button" aria-label="Refresh provider status" onClick={onRefresh} disabled={busy}>↻</button>
        </div>
      </header>

      {snapshot.access.mode === "read_only" ? (
        <div className="matrix-ap-notice" data-tone="neutral" role="status">
          <strong>Read only</strong>
          <span>{snapshot.access.reason === "remote_policy" ? "Your organization controls these settings." : `Changes are unavailable: ${titleCase(snapshot.access.reason).toLowerCase()}.`}</span>
        </div>
      ) : null}
      {error || enablement.error || gatewayError ? (
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
          onMutate={onMutate} onAddCredit={onAddCredit} onRefresh={onRefresh}
          selectedAgentName={harness?.displayName ?? null}
          selectedAgentEnabled={harness?.enabled ?? false}
          selectedModelName={gatewayModel?.displayName ?? null}
          isSelected={gatewaySelected}
          savedRouteUnavailable={gatewaySource !== null && harness?.accessSourceId === gatewaySource.id && !gatewaySelected}
          compatibleAgents={compatibleGatewayAgents}
          onChooseAgent={(id) => { setCollapsedId(null); onSelectHarness(id); }}
          onUseGateway={useGateway}
        />
        <HarnessRail
          harnesses={snapshot.harnesses}
          sources={snapshot.accessSources}
          statusOverride={workflowStatus}
          workflowHarnessIds={workflowCapabilities.map(item => item.harnessInstanceId)}
          selectedId={collapsedId === selectedId ? null : selectedId}
          disabled={mutationsDisabled}
          canEnable={(item) => !workflowCapabilities.some(cap => cap.harnessInstanceId === item.id) && configurationHarnessKinds.includes(item.harness) && supports("set_harness_enabled")}
          onEnable={(item) => { void onMutate({ type: "set_harness_enabled", harnessInstanceId: item.id,
            enabled: !(item.configuredEnabled ?? item.enabled) }); }}
          onSelect={(id) => {
            setCollapsedId(id === selectedId && collapsedId !== id ? id : null);
            onSelectHarness(id);
          }}
          renderDetails={(harness) => {
            const capability = workflowCapabilities.find(item => item.harnessInstanceId === harness.id);
            if (workflowClient && capability) return guidedPanel(harness, capability,
              genericConfiguration ? <>
                <ConnectionChoices snapshot={snapshot} harness={harness} gatewaySource={gatewaySource}
                  gatewaySelected={gatewaySelected} onUseGateway={useGateway}
                  canSetRoute={supports("set_route")} disabled={mutationsDisabled} onMutate={onMutate}
                  onRefreshForConnection={onRefreshForConnection}
                  onSetupHarness={onSetupHarness ? () => onSetupHarness(harness.harness) : undefined} />
                <HarnessEditor snapshot={snapshot} harness={harness} disabled={mutationsDisabled}
                  canUpdate={supports("update_harness")} canSetRoute={supports("set_route")}
                  canSelectSource={supports("select_access_source")} canSelectAccount={supports("select_account")}
                  onMutate={onMutate} onRefresh={onRefresh} />
              </> : undefined);
            return (<>
              <ConnectionChoices snapshot={snapshot} harness={harness} gatewaySource={gatewaySource}
                gatewaySelected={gatewaySelected} onUseGateway={useGateway} canSetRoute={genericConfiguration && supports("set_route")}
                disabled={mutationsDisabled} onMutate={onMutate}
                onRefreshForConnection={onRefreshForConnection}
                onSetupHarness={onSetupHarness ? () => onSetupHarness(harness.harness) : undefined} />
              {!gatewaySelected || (harness.harness !== "pi" && harness.harness !== "opencode") || harness.accountIds.length > 0 ? <SavedAccounts collapsed={gatewaySelected && (harness.harness === "pi" || harness.harness === "opencode")}><AccountsPanel
                harness={harness}
                accounts={snapshot.accounts.filter((account) => harness.accountIds.includes(account.id))}
                sources={snapshot.accessSources}
                allHarnesses={snapshot.harnesses}
                gatewayPolicy={snapshot.gatewayPolicy}
                attempt={connectionAttempt?.harnessInstanceId === harness.id ? connectionAttempt : null}
                disabled={mutationsDisabled}
                canLogin={supports("start_login")}
                canLogout={supports("logout_account")}
                canRemove={supports("remove_account")}
                canReassign={supports("reassign_account")}
                onMutate={onMutate}
                onOpenTerminal={onOpenTerminal}
                onOpenBrowser={onOpenBrowser}
                onSetupHarness={onSetupHarness}
                onRefresh={onRefresh}
              /></SavedAccounts> : null}
              <HarnessEditor
                snapshot={snapshot} harness={harness} disabled={mutationsDisabled}
                canUpdate={genericConfiguration && supports("update_harness")}
                canSetRoute={genericConfiguration && supports("set_route")}
                canSelectSource={genericConfiguration && supports("select_access_source")}
                canSelectAccount={genericConfiguration && supports("select_account")}
                onMutate={onMutate} onRefresh={onRefresh}
              />
            </>);
          }}
        />
        {workflowCapabilities.filter(item => !snapshot.harnesses.some(row => row.harness === item.harness)).map(item => <section key={item.harnessInstanceId} aria-label={item.displayName}><h2>{item.displayName}</h2>{guidedPanel({ id: item.harnessInstanceId, harness: item.harness, displayName: item.displayName, installState: item.installState, authState: "unknown" }, item)}</section>)}
        {snapshot.harnesses.length === 0 && workflowCapabilities.length === 0 ? (
            <div className="matrix-ap-empty-state">
              <strong>No agents found</strong>
              <span>Use + Add agent above to install or connect an agent.</span>
            </div>
        ) : null}
      </div>

      {addOpen && supports("add_harness") ? (
        <AddHarnessDialog snapshot={snapshot} onMutate={onMutate} onClose={() => setAddOpen(false)} onRefresh={onRefresh} onSetupHarness={onSetupHarness} busy={busy} error={error} />
      ) : null}
    </div>
  );
}
