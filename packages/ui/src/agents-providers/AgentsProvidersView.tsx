import { useEffect, useState, type ReactNode } from "react";
import { type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useGatewaySelection } from "./use-gateway-selection.js";
import { HarnessWorkflowPanel } from "./HarnessWorkflowPanel.js";
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
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
  const rememberOperation = (harnessId: string, id: string | null) =>
    setOperationIds((current) => {
      const next = { ...current };
      if (id === null) delete next[harnessId];
      else if (Object.keys(next).length < 32 || harnessId in next)
        next[harnessId] = id;
      return next;
    });
  useEffect(() => {
    setOperationIds({});
  }, [workflowClient]);
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
    setWorkflowCapabilities([]);
    setWorkflowPermission("unknown");
  }, [workflowClient]);
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
  useEffect(() => {
    setExpandedRowId(null);
    setWorkflowStatus(null);
  }, [workflowClient]);
  const inventoryHarnesses = workflowCapabilities.filter(
    (item) =>
      !snapshot.harnesses.some((harness) => harness.harness === item.harness),
  );
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
  const mutationsDisabled = busy || readOnly || gatewayPending;
  const errorPresentation = settingsErrorPresentation(
    gatewayError ? null : error,
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
            onClick={onRefresh}
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
      {error || gatewayError ? (
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
          onRefresh={onRefresh}
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
            onSelectHarness(id);
          }}
          onUseGateway={useGateway}
        />
        <HarnessRail
          harnesses={snapshot.harnesses}
          inventory={inventoryHarnesses}
          catalog={(snapshot.harnessCatalog ?? []).filter((entry) => !snapshot.harnesses.some((item) => item.harness === entry.harness) && !inventoryHarnesses.some((item) => item.harness === entry.harness))}
          renderCatalog={(entry) => <CatalogSetupPanel entry={entry} disabled={mutationsDisabled} onSetupHarness={onSetupHarness} onRefresh={onRefresh} />}
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
                onRefresh={onRefresh}
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
          selectedId={expandedRowId}
          disabled={mutationsDisabled}
          canEnable={(item) =>
            configurationHarnessKinds.includes(item.harness) &&
            supports("set_harness_enabled")
          }
          onEnable={(item) => {
            void onMutate({
              type: "set_harness_enabled",
              harnessInstanceId: item.id,
              enabled: !(item.configuredEnabled ?? item.enabled),
            });
          }}
          onSelect={(id) => {
            setExpandedRowId((current) => (current === id ? null : id));
            if (snapshot.harnesses.some((item) => item.id === id)) {
              onSelectHarness(id);
            }
          }}
          renderDetails={(harness) => {
            const capability = workflowCapabilities.find(
              (item) => item.harnessInstanceId === harness.id,
            );
            const guided = Boolean(workflowClient && capability);
            const accountsPanel = (connectionAction?: ReactNode) =>
              !gatewaySelected ||
              (harness.harness !== "pi" && harness.harness !== "opencode") ||
              harness.accountIds.length > 0 ? (
                <SavedAccounts
                  collapsed={
                    harness.authState !== "authenticated" ||
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
                      connectionAttempt?.harnessInstanceId === harness.id
                        ? connectionAttempt
                        : null
                    }
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
                  onSetupHarness={
                    onSetupHarness
                      ? () => onSetupHarness(harness.harness)
                      : undefined
                  }
                />
                {!guided ? <><ConnectionFallback harness={harness} workflowPermission={workflowPermission} disabled={mutationsDisabled} onSetupHarness={onSetupHarness} />{accountsPanel()}</> : null}
                {workflowClient &&
                workflowCapabilities.find(
                  (item) => item.harnessInstanceId === harness.id,
                ) ? (
                  <HarnessWorkflowPanel
                    key={harness.id}
                    renderConnection={harness.authState === "authenticated" ? accountsPanel : undefined}
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
                    onRefresh={onRefresh}
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
                    onRefresh={onRefresh}
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
          onRefresh={onRefresh}
          onSetupHarness={onSetupHarness}
          busy={busy}
          error={error}
        />
      ) : null}
    </div>
  );
}
