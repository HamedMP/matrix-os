import type { ProviderWorkflowCapability } from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "./HarnessWorkflowPanel.js";
import { ProviderWorkflowClientError } from "./provider-workflow-client.js";
import { resolveHarnessConnection } from "./harness-connection.js";
import { updateWorkflowRowStatus } from "./workflow-row-status.js";
import { useEffect, useState, type ReactNode } from "react";
import { isRunnableGenericHarnessCredentialRoute, isSupportedGenericHarnessCredentialRoute, type ProviderHarnessInstance, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AccountsPanel } from "./AccountsPanel.js";
import { AddHarnessDialog } from "./AddHarnessDialog.js";
import { GatewayPanel, isMatrixGatewaySourceReady, isMatrixGatewaySourceDiscoverable, matrixGatewayEligibleModels } from "./GatewayPanel.js";
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
}: AgentsProvidersViewProps) {
  const [workflowCapabilities, setWorkflowCapabilities] = useState<ProviderWorkflowCapability[]>([]);
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
  const [workflowStatus, setWorkflowStatus] = useState<Record<string, string>>({});
  const [stateClient, setStateClient] = useState(workflowClient);
  if (stateClient !== workflowClient) {
    setStateClient(workflowClient); setWorkflowCapabilities([]); setOperationIds({}); setWorkflowStatus({});
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
  const guidedPanel = (item: Pick<ProviderHarnessInstance, "id" | "harness" | "displayName" | "installState" | "authState"> & Partial<ProviderHarnessInstance>, capability: ProviderWorkflowCapability, advancedConfiguration?: import("react").ReactNode) => {
    if (!workflowClient) return null;
    const exact = snapshot.harnesses.find(row => row.id === item.id);
    const { account, source } = exact ? resolveHarnessConnection(exact, snapshot.accounts, snapshot.accessSources) : { account: undefined, source: undefined };
    const usage = source ? usageLines(source.usage) : null;
    return <HarnessWorkflowPanel harness={item} source={source} capability={capability} client={workflowClient}
      advancedConfiguration={advancedConfiguration} disabled={mutationsDisabled} operationId={operationIds[item.id] ?? capability.activeOperationId ?? null}
      onOperationId={id => rememberOperation(item.id, id)} onRefresh={onRefresh} onOpenTerminal={onOpenTerminal}
      onOpenAuthorizationUrl={onOpenAuthorizationUrl}
      onStateChange={status => setWorkflowStatus(current => updateWorkflowRowStatus(current, item.id, status))}
      renderConnection={action => <div className="matrix-ap-connected"><h3>Connection</h3>
        <div className="matrix-ap-account"><strong>{account?.displayName ?? source?.displayName ?? item.displayName}</strong>
          {usage ? <span>{usage.primary}{usage.secondary ? ` · ${usage.secondary}` : ""}</span> : null}{action}</div></div>}
      onDisconnect={exact && supports("set_harness_enabled") ? async () => await onMutate({ type: "set_harness_enabled", harnessInstanceId: exact.id, enabled: false }) : undefined} />;
  };
  const [addOpen, setAddOpen] = useState(false);
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const [gatewayPending, setGatewayPending] = useState(false);
  const [gatewayError, setGatewayError] = useState(false);
  const harness = selectedHarness(snapshot, selectedHarnessId);
  const actions = supportedActions(snapshot);
  const supports = (action: SupportedAction) => actions.includes(action);
  const readOnly = snapshot.access.mode === "read_only";
  const mutationsDisabled = busy || readOnly || gatewayPending;
  const errorPresentation = settingsErrorPresentation(gatewayError ? null : error);
  const selectedId = harness?.id ?? null;
  const configurationHarnessKinds = snapshot.configurationHarnessKinds ?? [];
  const genericConfiguration = harness !== null
    && harness !== undefined
    && harness.harness !== "claude" && harness.harness !== "codex"
    && configurationHarnessKinds.includes(harness.harness);
  // One Matrix balance, with separate exact serving routes behind it. Preserve
  // the selected managed route; prefer GLM only when choosing Matrix anew.
  const readyGatewaySource = (source: ProviderSettingsSnapshot["accessSources"][number]) =>
    isMatrixGatewaySourceReady(source, snapshot.gatewayPolicy,
      snapshot.modelProviders.find((provider) => provider.id === source.providerId) ?? null);
  const discoveredGatewaySources = snapshot.accessSources.filter((source) =>
    isMatrixGatewaySourceDiscoverable(source, snapshot.gatewayPolicy,
      snapshot.modelProviders.find((provider) => provider.id === source.providerId) ?? null));
  const gatewaySource = snapshot.accessSources.find((source) => source.kind === "matrix_gateway" && source.id === harness?.accessSourceId)
    ?? snapshot.accessSources.find((source) => source.id === "matrix_cloudflare" && readyGatewaySource(source))
    ?? snapshot.accessSources.find(readyGatewaySource)
    ?? discoveredGatewaySources.find((source) => source.readiness.safeReason === "credit_reserved"
      || source.readiness.safeReason === "credit_required")
    ?? discoveredGatewaySources[0]
    ?? snapshot.accessSources.find((source) => source.id === snapshot.gatewayPolicy?.accessSourceId)
    ?? snapshot.accessSources.find((source) => source.kind === "matrix_gateway") ?? null;
  const gatewayProvider = gatewaySource === null
    ? null
    : snapshot.modelProviders.find((provider) => provider.id === gatewaySource.providerId) ?? null;
  const eligibleGatewayModels = matrixGatewayEligibleModels(gatewaySource, snapshot.gatewayPolicy, gatewayProvider);
  const gatewayReady = isMatrixGatewaySourceReady(gatewaySource, snapshot.gatewayPolicy, gatewayProvider);
  const gatewayModelsFor = (item: ProviderHarnessInstance) => eligibleGatewayModels.filter((model) => gatewaySource !== null
    && isRunnableGenericHarnessCredentialRoute({ ...item, route: { kind: "configurable", providerId: gatewaySource.providerId, modelId: model.id }, accessSourceId: gatewaySource.id }, gatewaySource));
  const gatewayModels = harness ? gatewayModelsFor(harness) : [];
  const gatewayModel = gatewayModels.find((model) => model.id === harness?.route.modelId) ?? gatewayModels[0];
  const canUseGateway = genericConfiguration && supports("set_route") && harness?.installState === "installed" && harness.route.kind === "configurable"
    && gatewayReady && gatewayModel !== undefined;
  const gatewaySelected = gatewayReady && gatewaySource !== null && harness?.accessSourceId === gatewaySource.id
    && harness.route.providerId === gatewaySource.providerId
    && isSupportedGenericHarnessCredentialRoute(harness, gatewaySource)
    && eligibleGatewayModels.some((model) => model.id === harness.route.modelId);
  const compatibleGatewayAgents = supports("set_route") ? snapshot.harnesses.filter((item) =>
    item.id !== selectedId && item.installState === "installed" && item.route.kind === "configurable"
    && configurationHarnessKinds.includes(item.harness) && gatewayModelsFor(item).length > 0) : [];
  const useGateway = canUseGateway && harness && (harness.enabled || snapshot.atomicConnectSupported === true) && gatewaySource && gatewayModel ? async () => {
    if (mutationsDisabled) return;
    setGatewayPending(true);
    setGatewayError(false);
    try {
      const saved = await onMutate({ type: "set_route", harnessInstanceId: harness.id,
        route: { kind: "configurable", providerId: gatewaySource.providerId, modelId: gatewayModel.id },
        accessSourceId: gatewaySource.id, accountId: null,
        ...(snapshot.atomicConnectSupported === true ? { enableHarness: true } : {}) });
      if (saved === false) setGatewayError(true);
    } catch (caught) {
      console.warn("[provider-settings] Matrix connection failed:", caught instanceof Error ? caught.name : typeof caught);
      setGatewayError(true);
    } finally { setGatewayPending(false); }
  } : undefined;

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
      {error || gatewayError ? (
        <div className="matrix-ap-notice" data-tone="danger" role="alert">
          <strong>{errorPresentation.title}</strong>
          <span>{errorPresentation.message}</span>
        </div>
      ) : null}

      <div className="matrix-ap-workspace">
        <GatewayPanel
          key={gatewaySource?.id ?? "matrix-ai-unconfigured"}
          source={gatewaySource} policy={snapshot.gatewayPolicy} provider={gatewayProvider}
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
