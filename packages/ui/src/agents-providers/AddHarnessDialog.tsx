import { useMemo, useState } from "react";
import {
  isRunnableGenericHarnessCredentialRoute,
  type ProviderAccessSource,
  type ProviderGenericHarnessKind,
  type ProviderHarnessCatalogEntry,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { FeatureDialog } from "./FeatureDialog.js";
import type { ProviderSettingsMutationIntent } from "./types.js";

function catalogStatus(entry: ProviderHarnessCatalogEntry): string {
  const installed = {
    installed: "Installed",
    missing: "Not installed",
    installing: "Installing",
    failed: "Install failed",
    unknown: "Install status unknown",
  }[entry.installState];
  const state = entry.runnable ? "Ready" : {
    runtime_not_supported: "Unavailable in this runtime",
    not_installed: "Install required",
    installing: "Setup in progress",
    install_failed: "Retry required",
    install_state_unknown: "Status unavailable",
    setup_required: "Setup required",
    runtime_unavailable: "Unavailable",
  }[entry.safeReason!];
  return `${installed} · ${state}`;
}

function setupCopy(entry: ProviderHarnessCatalogEntry): { title: string; body: string } | null {
  if (entry.runnable || !entry.available) return null;
  if (entry.setupAction === "install") {
    return {
      title: `Install ${entry.displayName} before adding it`,
      body: `Open Terminal and use the + menu to install ${entry.displayName}. Refresh this page when the install finishes.`,
    };
  }
  if (entry.setupAction === "open_terminal" || entry.setupAction === "connect_account"
    || entry.setupAction === "enter_api_key") {
    return {
      title: `Finish ${entry.displayName} setup before adding it`,
      body: `Open Terminal and run ${entry.displayName} once to finish setup or authentication. Then refresh this page.`,
    };
  }
  return {
    title: `${entry.displayName} isn't ready yet`,
    body: "Refresh provider status after the current setup finishes. If the status does not recover, open Terminal to inspect the harness.",
  };
}

function sourceSupportsRoute(
  snapshot: ProviderSettingsSnapshot,
  harness: ProviderGenericHarnessKind,
  source: ProviderSettingsSnapshot["accessSources"][number],
  providerId: string,
  modelId: string,
): boolean {
  if (source.providerId !== providerId || !source.eligibleModelIds.includes(modelId)) return false;
  const gatewayAllowed = source.kind !== "matrix_gateway"
    || (snapshot.gatewayPolicy?.accessSourceId === source.id
      && snapshot.gatewayPolicy.allowedModelIds.includes(modelId));
  if (!gatewayAllowed) return false;
  if (harness !== "pi" && harness !== "opencode") return true;
  return isRunnableGenericHarnessCredentialRoute({
    harness,
    accessSourceId: source.id,
    route: { kind: "configurable", providerId, modelId },
  }, source as ProviderAccessSource);
}

function modelsForProvider(
  snapshot: ProviderSettingsSnapshot,
  harness: ProviderGenericHarnessKind,
  provider: ProviderSettingsSnapshot["modelProviders"][number],
) {
  return provider.models.filter((model) => model.enabled && snapshot.accessSources.some((source) =>
    sourceSupportsRoute(snapshot, harness, source, provider.id, model.id)));
}

function providersForHarness(
  snapshot: ProviderSettingsSnapshot,
  harness: ProviderGenericHarnessKind,
) {
  return snapshot.modelProviders.filter((provider) =>
    modelsForProvider(snapshot, harness, provider).length > 0);
}

export function AddHarnessDialog({
  snapshot,
  onMutate,
  onClose,
}: {
  snapshot: ProviderSettingsSnapshot;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
  onClose: () => void;
}) {
  const firstCatalog = snapshot.harnessCatalog.find((entry) => entry.available)
    ?? snapshot.harnessCatalog[0]!;
  const [kind, setKind] = useState<ProviderGenericHarnessKind>(firstCatalog.harness);
  const selectedCatalog = snapshot.harnessCatalog.find((entry) => entry.harness === kind) ?? firstCatalog;
  const eligibleProviders = useMemo(() => providersForHarness(snapshot, kind), [kind, snapshot]);
  const defaultProvider = eligibleProviders[0] ?? null;
  const [displayName, setDisplayName] = useState(selectedCatalog.displayName);
  const [providerId, setProviderId] = useState(defaultProvider?.id ?? "");
  const provider = eligibleProviders.find((candidate) => candidate.id === providerId) ?? defaultProvider;
  const eligibleModels = useMemo(() => provider === null ? [] : modelsForProvider(snapshot, kind, provider),
    [kind, provider, snapshot]);
  const firstModel = eligibleModels[0] ?? null;
  const [modelId, setModelId] = useState(firstModel?.id ?? "");
  const eligibleSources = useMemo(() => snapshot.accessSources.filter((source) =>
    sourceSupportsRoute(snapshot, kind, source, provider?.id ?? "", modelId)),
    [kind, modelId, provider, snapshot]);
  const [sourceId, setSourceId] = useState(eligibleSources[0]?.id ?? "");
  const selectedSource = eligibleSources.find((source) => source.id === sourceId) ?? eligibleSources[0] ?? null;
  const canAdd = selectedCatalog.available && selectedCatalog.runnable
    && displayName.trim() !== "" && provider !== null && modelId !== "" && selectedSource !== null;
  const setup = setupCopy(selectedCatalog);

  const selectKind = (nextKind: ProviderGenericHarnessKind) => {
    const catalog = snapshot.harnessCatalog.find((entry) => entry.harness === nextKind) ?? snapshot.harnessCatalog[0]!;
    const nextProvider = providersForHarness(snapshot, nextKind)[0] ?? null;
    const nextModel = nextProvider ? modelsForProvider(snapshot, nextKind, nextProvider)[0] ?? null : null;
    const nextSource = nextModel === null ? undefined : snapshot.accessSources.find((source) =>
      sourceSupportsRoute(snapshot, nextKind, source, nextProvider?.id ?? "", nextModel.id));
    setKind(nextKind);
    setDisplayName(catalog.displayName);
    setProviderId(nextProvider?.id ?? "");
    setModelId(nextModel?.id ?? "");
    setSourceId(nextSource?.id ?? "");
  };

  const selectProvider = (nextProviderId: string) => {
    const nextProvider = eligibleProviders.find((candidate) => candidate.id === nextProviderId) ?? null;
    const nextModel = nextProvider ? modelsForProvider(snapshot, kind, nextProvider)[0] ?? null : null;
    const nextSource = nextModel === null ? undefined : snapshot.accessSources.find((source) =>
      sourceSupportsRoute(snapshot, kind, source, nextProviderId, nextModel.id));
    setProviderId(nextProviderId);
    setModelId(nextModel?.id ?? "");
    setSourceId(nextSource?.id ?? "");
  };

  const selectModel = (nextModelId: string) => {
    const nextSource = snapshot.accessSources.find((source) =>
      sourceSupportsRoute(snapshot, kind, source, provider?.id ?? "", nextModelId));
    setModelId(nextModelId);
    setSourceId(nextSource?.id ?? "");
  };

  const add = () => {
    if (!canAdd || selectedSource === null) return;
    onMutate({
      type: "add_harness",
      harness: kind,
      displayName: displayName.trim(),
      route: {
        kind: "configurable",
        providerId: provider!.id,
        modelId,
      },
      accessSourceId: selectedSource.id,
      accountId: selectedSource.accountId,
    });
    onClose();
  };

  return (
    <FeatureDialog title="Add harness" onClose={onClose}>
      <div className="matrix-ap-driver-grid">
        {snapshot.harnessCatalog.map((entry) => {
          const statusId = `matrix-ap-harness-status-${entry.harness}`;
          return (
            <label
              key={entry.harness}
              data-selected={entry.harness === kind ? "true" : undefined}
              data-available={entry.available ? "true" : "false"}
              data-runnable={entry.runnable ? "true" : "false"}
            >
              <input
                type="radio"
                name="harness-kind"
                value={entry.harness}
                checked={entry.harness === kind}
                disabled={!entry.available}
                aria-label={entry.displayName}
                aria-describedby={statusId}
                onChange={() => selectKind(entry.harness)}
              />
              <span>{entry.displayName}</span>
              <small id={statusId}>{catalogStatus(entry)}</small>
            </label>
          );
        })}
      </div>
      {setup ? (
        <div className="matrix-ap-setup-notice" role="status">
          <strong>{setup.title}</strong>
          <span>{setup.body}</span>
        </div>
      ) : null}
      <label className="matrix-ap-field">
        <span>Display name</span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} />
      </label>
      <div className="matrix-ap-panel-head">
        <div><span className="matrix-ap-eyebrow">Model</span><h3>Choose the model</h3></div>
      </div>
      <div className="matrix-ap-form-grid">
        <label className="matrix-ap-field">
          <span>Provider</span>
          <select aria-label="Model provider" value={provider?.id ?? ""} onChange={(event) => selectProvider(event.target.value)} disabled={!selectedCatalog.runnable}>
            {eligibleProviders.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
          </select>
        </label>
        <label className="matrix-ap-field">
          <span>Model</span>
          <select value={modelId} onChange={(event) => selectModel(event.target.value)} disabled={!selectedCatalog.runnable}>
            {eligibleModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
        </label>
      </div>
      <div className="matrix-ap-panel-head">
        <div><span className="matrix-ap-eyebrow">Access &amp; billing</span><h3>Choose how this route is funded</h3></div>
      </div>
      <label className="matrix-ap-field">
        <span>Paid through</span>
        <select aria-label="Paid through" value={selectedSource?.id ?? ""} onChange={(event) => setSourceId(event.target.value)} disabled={!selectedCatalog.runnable}>
          {eligibleSources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.displayName}{source.readiness.state === "ready" ? "" : " · authentication required"}
            </option>
          ))}
        </select>
      </label>
      <p className="matrix-ap-help">
        {selectedSource?.kind === "harness_profile"
          ? `${selectedCatalog.displayName} manages authentication for this route. Add or switch accounts from its visible Terminal flow.`
          : selectedSource && selectedSource.readiness.state !== "ready"
          ? "After adding the harness, continue authentication from Accounts in a visible Terminal, browser, or secure credential prompt."
          : "Authentication always continues in a visible Terminal, browser, or secure credential prompt."}
      </p>
      <div className="matrix-ap-dialog-actions">
        <button type="button" className="matrix-ap-button" onClick={onClose}>Cancel</button>
        <button type="button" className="matrix-ap-button matrix-ap-button-primary" disabled={!canAdd} onClick={add}>Add harness</button>
      </div>
    </FeatureDialog>
  );
}
