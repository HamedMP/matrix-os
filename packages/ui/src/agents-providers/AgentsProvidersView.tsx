import { useState } from "react";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AccountsPanel } from "./AccountsPanel.js";
import { AddHarnessDialog } from "./AddHarnessDialog.js";
import { GatewayPanel } from "./GatewayPanel.js";
import { HarnessEditor } from "./HarnessEditor.js";
import { HarnessRail } from "./HarnessRail.js";
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
  onMutate,
  onOpenTerminal,
  onOpenBrowser,
  onAddCredit,
}: AgentsProvidersViewProps) {
  const [addOpen, setAddOpen] = useState(false);
  const harness = selectedHarness(snapshot, selectedHarnessId);
  const actions = supportedActions(snapshot);
  const supports = (action: SupportedAction) => actions.includes(action);
  const readOnly = snapshot.access.mode === "read_only";
  const mutationsDisabled = busy || readOnly;
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

  return (
    <div className="matrix-agents-providers" aria-busy={busy ? "true" : undefined}>
      <header className="matrix-ap-page-head">
        <div>
          <span className="matrix-ap-eyebrow">Settings</span>
          <h1>Agents &amp; providers</h1>
          <p>Choose which harness runs a task, which model it uses, and who funds the route.</p>
        </div>
        <div className="matrix-ap-refresh">
          <span>Checked {relativeCheckedAt(snapshot.refreshedAt)}</span>
          <button type="button" className="matrix-ap-icon-button" aria-label="Refresh provider status" onClick={onRefresh} disabled={busy}>↻</button>
        </div>
      </header>

      {snapshot.access.mode === "read_only" ? (
        <div className="matrix-ap-notice" data-tone="neutral" role="status">
          <strong>Read only</strong>
          <span>{snapshot.access.reason === "remote_policy" ? "Your organization controls these settings." : `Changes are unavailable: ${titleCase(snapshot.access.reason).toLowerCase()}.`}</span>
        </div>
      ) : null}
      {error ? (
        <div className="matrix-ap-notice" data-tone="danger" role="alert">
          <strong>Settings could not be updated</strong>
          <span>Changes were not saved. Refresh and try again.</span>
        </div>
      ) : null}

      <div className="matrix-ap-workspace">
        <HarnessRail
          harnesses={snapshot.harnesses}
          selectedId={selectedId}
          disabled={mutationsDisabled}
          canAdd={supports("add_harness") && configurationHarnessKinds.length > 0}
          onSelect={onSelectHarness}
          onAdd={() => setAddOpen(true)}
        />
        <main className="matrix-ap-main">
          {harness ? (
            <>
              <HarnessEditor
                snapshot={snapshot}
                harness={harness}
                disabled={mutationsDisabled}
                canUpdate={genericConfiguration && supports("update_harness")}
                canEnable={genericConfiguration && supports("set_harness_enabled")}
                canSetRoute={genericConfiguration && supports("set_route")}
                canSelectSource={genericConfiguration && supports("select_access_source")}
                canSelectAccount={genericConfiguration && supports("select_account")}
                onMutate={onMutate}
              />
              <AccountsPanel
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
              />
              {gatewaySource ? (
                <GatewayPanel
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
                />
              ) : null}
            </>
          ) : (
            <div className="matrix-ap-empty-state">
              <strong>No harnesses configured</strong>
              <span>Add Hermes, OpenClaw, Pi, or OpenCode to begin.</span>
              <button type="button" className="matrix-ap-button matrix-ap-button-primary" disabled={mutationsDisabled || !supports("add_harness") || configurationHarnessKinds.length === 0} onClick={() => setAddOpen(true)}>Add harness</button>
            </div>
          )}
        </main>
      </div>

      {addOpen && supports("add_harness") ? (
        <AddHarnessDialog snapshot={snapshot} onMutate={onMutate} onClose={() => setAddOpen(false)} />
      ) : null}
    </div>
  );
}
