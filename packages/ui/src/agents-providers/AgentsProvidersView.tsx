import { useEffect, useState, type ReactNode } from "react";
import { type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useHarnessEnablement } from "./use-harness-enablement.js";
import { useGatewaySelection } from "./use-gateway-selection.js";
import { HarnessWorkflowPanel } from "./HarnessWorkflowPanel.js";
import { hasConfiguredConnection } from "./harness-connection.js";
import { UsageHistoryDialog } from "./UsageHistoryDialog.js";
import type { ProviderWorkflowCapability } from "@matrix-os/contracts";
import { AccountsPanel } from "./AccountsPanel.js";
import { AddHarnessDialog } from "./AddHarnessDialog.js";
import { GatewayPanel } from "./GatewayPanel.js";
import { HarnessEditor } from "./HarnessEditor.js";
import { HarnessRail } from "./HarnessRail.js";
import { ProviderWorkflowClientError } from "./provider-workflow-client.js";
import { CatalogSetupPanel } from "./CatalogSetupPanel.js";
import { ConnectionFallback } from "./ConnectionFallback.js";
import { ConnectionChoices } from "./ConnectionChoices.js";
import { settingsErrorPresentation } from "./settings-error-presentation.js";
import type {
  AgentsProvidersViewProps,
  ProviderSettingsMutationIntent,
} from "./types.js";
import { relativeCheckedAt, selectedHarness, titleCase } from "./utils.js";

export type {
  AgentsProvidersViewProps,
  ProviderSettingsMutationIntent,
} from "./types.js";

type SupportedAction =
  | ProviderSettingsMutationIntent["type"]
  | "add_credit"
  | "submit_api_key";

function supportedActions(
  snapshot: ProviderSettingsSnapshot,
): readonly SupportedAction[] {
  return (
    (
      snapshot as ProviderSettingsSnapshot & {
        supportedActions?: readonly SupportedAction[];
      }
    ).supportedActions ?? []
  );
}

function SavedAccounts({
  collapsed,
  children,
  title = "Manage saved accounts",
}: {
  collapsed: boolean;
  children: ReactNode;
  title?: string;
}) {
  return collapsed ? (
    <details className="matrix-ap-advanced">
      <summary>{title}</summary>
      {children}
    </details>
  ) : (
    children
  );
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
  const [connectRequests, setConnectRequests] = useState<Record<string, number>>({});
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
  const rememberOperation = (harnessId: string, id: string | null) =>
    setOperationIds((current) => {
      const next = { ...current };
      if (id === null) delete next[harnessId];
      else if (Object.keys(next).length < 32 || harnessId in next)
        next[harnessId] = id;
      return next;
    });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [workflowCapabilities, setWorkflowCapabilities] = useState<
    ProviderWorkflowCapability[]
  >([]);
  const [workflowPermission, setWorkflowPermission] = useState<"unknown" | "available" | "forbidden">("unknown");
  const [workflowStatus, setWorkflowStatus] = useState<{
    id: string;
    status: string | null;
  } | null>(null);
  useEffect(() => {
    if (!workflowClient) return;
    const controller = new AbortController();
    void workflowClient
      .capabilities(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setWorkflowCapabilities(value);
          setWorkflowPermission("available");
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          console.warn(
            "[provider-settings] Workflow capabilities unavailable:",
            caught instanceof Error ? caught.name : typeof caught,
          );
          setWorkflowCapabilities([]);
          setWorkflowPermission(caught instanceof ProviderWorkflowClientError && caught.reason === "forbidden" ? "forbidden" : "unknown");
        }
      });
    return () => controller.abort();
  }, [workflowClient, snapshot.refreshedAt]);
  const [addOpen, setAddOpen] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [expandedRowKind, setExpandedRowKind] = useState<ProviderWorkflowCapability["harness"] | null>(null);
  const [stateClient, setStateClient] = useState(workflowClient);
  // Reset before rendering a different runtime transport. Effects would first
  // expose the former client's attempts/capabilities and collapse a frame later.
  if (stateClient !== workflowClient) {
    setStateClient(workflowClient);
    setOperationIds({});
    setConnectRequests({});
    setWorkflowCapabilities([]);
    setWorkflowPermission("unknown");
    setExpandedRowId(null);
    setExpandedRowKind(null);
    setWorkflowStatus(null);
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
  const resolvedExpandedId = expandedRowId === null ? null
    : rowIdentities.some(item => item.id === expandedRowId) ? expandedRowId
    : rowIdentities.find(item => item.harness === expandedRowKind)?.id ?? null;
  const harness = selectedHarness(snapshot, selectedHarnessId);
  const actions = supportedActions(snapshot);
  const supports = (action: SupportedAction) => actions.includes(action);
  const readOnly = snapshot.access.mode === "read_only";
  const selectedId = harness?.id ?? null;
  const configurationHarnessKinds = snapshot.configurationHarnessKinds ?? [];
  const {
    gatewayPending,
    gatewayError,
    genericConfiguration,
    gatewaySource,
    gatewayProvider,
    gatewayModel,
    gatewaySelected,
    compatibleGatewayAgents,
    useGateway,
  } = useGatewaySelection({
    snapshot,
    harness,
    selectedId,
    disabled: busy || readOnly,
    supports,
    onMutate,
  });
  const enablement = useHarnessEnablement({ snapshot, refresh: onRefreshForConnection, mutate: onMutate });
  const visibleError = error ?? enablement.error;
  const refreshSettings = () => { enablement.clearError(); onRefresh(); };
  const mutationsDisabled = busy || readOnly || gatewayPending || enablement.pending;
  const errorPresentation = settingsErrorPresentation(
    gatewayError ? null : visibleError,
  );

  return (
    <div
      className="matrix-agents-providers"
      aria-busy={busy || gatewayPending ? "true" : undefined}
    >
      <header className="matrix-ap-page-head">
        <div>
          <h1>Agents &amp; providers</h1>
          <p>Connect and manage the agents on this computer.</p>
        </div>
        <div className="matrix-ap-refresh">
          <span>Checked {relativeCheckedAt(snapshot.refreshedAt)}</span>
          {supports("add_harness") && configurationHarnessKinds.length > 0 ? (
            <button
              type="button"
              className="matrix-ap-icon-button"
              aria-label="Add agent"
              title="Add agent"
              onClick={() => setAddOpen(true)}
              disabled={mutationsDisabled}
            >
              +
            </button>
          ) : null}
          <button
            type="button"
            className="matrix-ap-icon-button"
            aria-label="Refresh provider status"
            onClick={refreshSettings}
            disabled={busy}
          >
            ↻
          </button>
        </div>
      </header>

      {snapshot.access.mode === "read_only" ? (
        <div className="matrix-ap-notice" data-tone="neutral" role="status">
          <strong>Read only</strong>
          <span>
            {snapshot.access.reason === "remote_policy"
              ? "Your organization controls these settings."
              : `Changes are unavailable: ${titleCase(snapshot.access.reason).toLowerCase()}.`}
          </span>
        </div>
      ) : null}
      {visibleError || gatewayError ? (
        <div className="matrix-ap-notice" data-tone="danger" role="alert">
          <strong>{errorPresentation.title}</strong>
          <span>{errorPresentation.message}</span>
        </div>
      ) : null}

      <div className="matrix-ap-workspace">
        <GatewayPanel
          key={gatewaySource?.id ?? "matrix-ai-unconfigured"}
          source={gatewaySource}
          policy={snapshot.gatewayPolicy}
          provider={gatewayProvider}
          disabled={mutationsDisabled}
          canSetBudget={supports("set_gateway_budget")}
          canSetAllowlist={supports("set_gateway_allowlist")}
          canAddCredit={supports("add_credit")}
          onMutate={onMutate}
          onAddCredit={onAddCredit}
          onRefresh={refreshSettings}
          onUsageHistory={
            onLoadUsageHistory ? () => setHistoryOpen(true) : undefined
          }
          selectedAgentName={harness?.displayName ?? null}
          selectedAgentEnabled={harness?.enabled ?? false}
          selectedModelName={gatewayModel?.displayName ?? null}
          isSelected={gatewaySelected}
          savedRouteUnavailable={
            gatewaySource !== null &&
            harness?.accessSourceId === gatewaySource.id &&
            !gatewaySelected
          }
          compatibleAgents={compatibleGatewayAgents}
          onChooseAgent={(id) => {
            setExpandedRowId(id);
            setExpandedRowKind(snapshot.harnesses.find(item => item.id === id)?.harness ?? null);
            onSelectHarness(id);
          }}
          onUseGateway={useGateway}
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
                  setWorkflowStatus((current) =>
                    current?.id === item.harnessInstanceId &&
                    current.status === status
                      ? current
                      : { id: item.harnessInstanceId, status },
                  )
                }
              />
            ) : null
          }
          sources={snapshot.accessSources}
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
            const source = snapshot.accessSources.find(item => item.id === harness.accessSourceId);
            const connected = hasConfiguredConnection(harness, source);
            const accountsPanel = (connectionAction?: ReactNode) =>
              !gatewaySelected ||
              (harness.harness !== "pi" && harness.harness !== "opencode") ||
              harness.accountIds.length > 0 ? (
                <SavedAccounts
                  collapsed={
                    !connected ||
                    (gatewaySelected &&
                    (harness.harness === "pi" || harness.harness === "opencode"))
                  }
                >
                  <AccountsPanel
                    harness={harness}
                    connectionAction={connectionAction}
                    guided={workflowCapabilities.some(
                      (item) =>
                        item.harnessInstanceId === harness.id &&
                        (item.loginMethods.length > 0 ||
                          item.apiKeyProviders.length > 0 ||
                          item.install),
                    )}
                    accounts={snapshot.accounts.filter((account) =>
                      harness.accountIds.includes(account.id),
                    )}
                    sources={snapshot.accessSources}
                    allHarnesses={snapshot.harnesses}
                    gatewayPolicy={snapshot.gatewayPolicy}
                    attempt={
                      connectionAttempt?.harnessInstanceId === harness.id && connectionAttempt.action.kind !== "open_terminal"
                        ? connectionAttempt
                        : null
                    }
                    disabled={mutationsDisabled}
                    canLogin={false}
                    canLogout={supports("logout_account")}
                    canRemove={supports("remove_account")}
                    canReassign={supports("reassign_account")}
                    onMutate={onMutate}
                    onOpenTerminal={onOpenTerminal}
                    onOpenBrowser={onOpenBrowser}
                    onSetupHarness={workflowPermission === "forbidden" ? undefined : onSetupHarness}
                    onRefresh={refreshSettings}
                  />
                </SavedAccounts>
              ) : null;
            return (
              <>
                <ConnectionChoices
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
                    ? async () => {
                        setConnectRequests(current => ({ [harness.id]: (current[harness.id] ?? 0) + 1 }));
                        return true;
                      }
                    : undefined}

                />
                {!guided ? <><ConnectionFallback harness={harness} workflowPermission={workflowPermission} disabled={mutationsDisabled} onSetupHarness={onSetupHarness} />{accountsPanel()}</> : null}
                {workflowClient &&
                workflowCapabilities.find(
                  (item) => item.harnessInstanceId === harness.id,
                ) ? (
                  <HarnessWorkflowPanel
                    key={harness.id}
                    connectRequest={connectRequests[harness.id] ?? 0}
                    renderConnection={connected ? accountsPanel : undefined}
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
                      setWorkflowStatus((current) =>
                        current?.id === harness.id && current.status === status
                          ? current
                          : { id: harness.id, status },
                      )
                    }
                    onDisconnect={
                      supports("logout_account") && harness.selectedAccountId
                        ? async () => {
                            return await onMutate({
                              type: "logout_account",
                              accountId: harness.selectedAccountId!,
                            });
                          }
                        : undefined
                    }
                  />
                ) : null}
                <SavedAccounts
                  title="Advanced configuration"
                  collapsed={true}
                >
                  <HarnessEditor
                    snapshot={snapshot}
                    harness={harness}
                    disabled={mutationsDisabled}
                    canUpdate={
                      genericConfiguration && supports("update_harness")
                    }
                    canSetRoute={genericConfiguration && supports("set_route")}
                    canSelectSource={
                      genericConfiguration && supports("select_access_source")
                    }
                    canSelectAccount={
                      genericConfiguration && supports("select_account")
                    }
                    onMutate={onMutate}
                    onRefresh={refreshSettings}
                  />
                </SavedAccounts>
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

      {historyOpen && onLoadUsageHistory ? (
        <UsageHistoryDialog
          load={onLoadUsageHistory}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
      {addOpen && supports("add_harness") ? (
        <AddHarnessDialog
          snapshot={snapshot}
          onMutate={onMutate}
          onClose={() => setAddOpen(false)}
          onRefresh={refreshSettings}
          onSetupHarness={onSetupHarness}
          busy={busy}
          error={error}
        />
      ) : null}
    </div>
  );
}
