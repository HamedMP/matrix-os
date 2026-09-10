import { useState, type ReactNode } from "react";
import { isRunnableGenericHarnessCredentialRoute, isSupportedGenericHarnessCredentialRoute, type ProviderHarnessInstance, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AccountsPanel } from "./AccountsPanel.js";
import { AddHarnessDialog } from "./AddHarnessDialog.js";
import { GatewayPanel } from "./GatewayPanel.js";
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
  onMutate,
  onOpenTerminal,
  onOpenBrowser,
  onAddCredit,
  onSetupHarness,
}: AgentsProvidersViewProps) {
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
    && configurationHarnessKinds.includes(harness.harness);
  const gatewaySource = snapshot.gatewayPolicy === null
    ? snapshot.accessSources.find((source) => source.kind === "matrix_gateway") ?? null
    : snapshot.accessSources.find((source) => source.id === snapshot.gatewayPolicy?.accessSourceId) ?? null;
  const gatewayProvider = gatewaySource === null
    ? null
    : snapshot.modelProviders.find((provider) => provider.id === gatewaySource.providerId) ?? null;
  const eligibleGatewayModels = gatewayProvider?.models.filter((model) => model.enabled
    && gatewaySource?.eligibleModelIds.includes(model.id)
    && snapshot.gatewayPolicy?.allowedModelIds.includes(model.id)) ?? [];
  const gatewayModelsFor = (item: ProviderHarnessInstance) => eligibleGatewayModels.filter((model) => gatewaySource !== null
    && isRunnableGenericHarnessCredentialRoute({ ...item, route: { kind: "configurable", providerId: gatewaySource.providerId, modelId: model.id }, accessSourceId: gatewaySource.id }, gatewaySource));
  const gatewayModels = harness ? gatewayModelsFor(harness) : [];
  const gatewayModel = gatewayModels.find((model) => model.id === harness?.route.modelId) ?? gatewayModels[0];
  const canUseGateway = genericConfiguration && supports("set_route") && harness?.installState === "installed" && harness.route.kind === "configurable"
    && gatewaySource?.readiness.state === "ready" && gatewayModel !== undefined;
  const gatewaySelected = gatewaySource !== null && harness?.accessSourceId === gatewaySource.id
    && harness.route.providerId === gatewaySource.providerId
    && isSupportedGenericHarnessCredentialRoute(harness, gatewaySource)
    && eligibleGatewayModels.some((model) => model.id === harness.route.modelId);
  const compatibleGatewayAgents = supports("set_route") ? snapshot.harnesses.filter((item) =>
    item.id !== selectedId && item.installState === "installed" && item.route.kind === "configurable"
    && configurationHarnessKinds.includes(item.harness) && gatewayModelsFor(item).length > 0) : [];
  const useGateway = canUseGateway && harness && gatewaySource && gatewayModel ? async () => {
    if (mutationsDisabled) return;
    setGatewayPending(true);
    setGatewayError(false);
    try {
      const saved = await onMutate({ type: "set_route", harnessInstanceId: harness.id,
        route: { kind: "configurable", providerId: gatewaySource.providerId, modelId: gatewayModel.id },
        accessSourceId: gatewaySource.id, accountId: null, enableHarness: true });
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
          selectedId={collapsedId === selectedId ? null : selectedId}
          disabled={mutationsDisabled}
          canEnable={(item) => configurationHarnessKinds.includes(item.harness) && supports("set_harness_enabled")}
          onEnable={(item) => { void onMutate({ type: "set_harness_enabled", harnessInstanceId: item.id, enabled: !item.enabled }); }}
          onSelect={(id) => {
            setCollapsedId(id === selectedId && collapsedId !== id ? id : null);
            onSelectHarness(id);
          }}
          renderDetails={(harness) => (
            <>
              <ConnectionChoices snapshot={snapshot} harness={harness} gatewaySource={gatewaySource}
                gatewaySelected={gatewaySelected} onUseGateway={useGateway} canSetRoute={genericConfiguration && supports("set_route")}
                disabled={mutationsDisabled} onMutate={onMutate}
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
            </>
          )}
        />
        {snapshot.harnesses.length === 0 ? (
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
