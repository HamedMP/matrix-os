import { useMemo, useState } from "react";
import type { ProviderHarnessKind, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { FeatureDialog } from "./FeatureDialog.js";
import type { ProviderSettingsMutationIntent } from "./types.js";

const HARNESS_CATALOG: ReadonlyArray<{
  id: ProviderHarnessKind;
  label: string;
  routeKind: "configurable" | "fixed";
  preferredProvider: string | null;
}> = [
  { id: "hermes", label: "Hermes", routeKind: "configurable", preferredProvider: null },
  { id: "openclaw", label: "OpenClaw", routeKind: "configurable", preferredProvider: null },
  { id: "pi", label: "Pi", routeKind: "configurable", preferredProvider: null },
  { id: "opencode", label: "OpenCode", routeKind: "configurable", preferredProvider: null },
  { id: "codex", label: "Codex", routeKind: "fixed", preferredProvider: "openai" },
  { id: "claude", label: "Claude", routeKind: "fixed", preferredProvider: "anthropic" },
];

function sourceSupportsRoute(
  snapshot: ProviderSettingsSnapshot,
  source: ProviderSettingsSnapshot["accessSources"][number],
  providerId: string,
  modelId: string,
): boolean {
  if (source.providerId !== providerId || !source.eligibleModelIds.includes(modelId)) return false;
  if (source.kind !== "matrix_gateway") return true;
  return snapshot.gatewayPolicy?.accessSourceId === source.id
    && snapshot.gatewayPolicy.allowedModelIds.includes(modelId);
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
  const existing = new Set(snapshot.harnesses.map((harness) => harness.harness));
  const firstAvailable = HARNESS_CATALOG.find((entry) => !existing.has(entry.id)) ?? HARNESS_CATALOG[0]!;
  const [kind, setKind] = useState<ProviderHarnessKind>(firstAvailable.id);
  const selectedCatalog = HARNESS_CATALOG.find((entry) => entry.id === kind) ?? firstAvailable;
  const defaultProvider = snapshot.modelProviders.find((provider) => provider.id === selectedCatalog.preferredProvider)
    ?? snapshot.modelProviders[0]
    ?? null;
  const [displayName, setDisplayName] = useState(selectedCatalog.label);
  const [providerId, setProviderId] = useState(defaultProvider?.id ?? "");
  const provider = snapshot.modelProviders.find((candidate) => candidate.id === providerId) ?? defaultProvider;
  const firstModel = provider?.models.find((model) => model.enabled) ?? null;
  const [modelId, setModelId] = useState(firstModel?.id ?? "");
  const eligibleSources = useMemo(() => snapshot.accessSources.filter((source) =>
    sourceSupportsRoute(snapshot, source, providerId, modelId)), [modelId, providerId, snapshot]);
  const [sourceId, setSourceId] = useState(eligibleSources[0]?.id ?? "");
  const selectedSource = eligibleSources.find((source) => source.id === sourceId) ?? eligibleSources[0] ?? null;
  const canAdd = displayName.trim() !== "" && provider !== null && modelId !== "" && selectedSource !== null;

  const selectKind = (nextKind: ProviderHarnessKind) => {
    const catalog = HARNESS_CATALOG.find((entry) => entry.id === nextKind) ?? HARNESS_CATALOG[0]!;
    const nextProvider = snapshot.modelProviders.find((candidate) => candidate.id === catalog.preferredProvider)
      ?? snapshot.modelProviders[0]
      ?? null;
    const nextModel = nextProvider?.models.find((model) => model.enabled) ?? null;
    const nextSource = nextModel === null ? undefined : snapshot.accessSources.find((source) =>
      sourceSupportsRoute(snapshot, source, nextProvider?.id ?? "", nextModel.id));
    setKind(nextKind);
    setDisplayName(catalog.label);
    setProviderId(nextProvider?.id ?? "");
    setModelId(nextModel?.id ?? "");
    setSourceId(nextSource?.id ?? "");
  };

  const selectProvider = (nextProviderId: string) => {
    const nextProvider = snapshot.modelProviders.find((candidate) => candidate.id === nextProviderId) ?? null;
    const nextModel = nextProvider?.models.find((model) => model.enabled) ?? null;
    const nextSource = nextModel === null ? undefined : snapshot.accessSources.find((source) =>
      sourceSupportsRoute(snapshot, source, nextProviderId, nextModel.id));
    setProviderId(nextProviderId);
    setModelId(nextModel?.id ?? "");
    setSourceId(nextSource?.id ?? "");
  };

  const selectModel = (nextModelId: string) => {
    const nextSource = snapshot.accessSources.find((source) =>
      sourceSupportsRoute(snapshot, source, providerId, nextModelId));
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
        kind: selectedCatalog.routeKind,
        providerId,
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
        {HARNESS_CATALOG.map((entry) => (
          <label key={entry.id} data-selected={entry.id === kind ? "true" : undefined} data-installed={existing.has(entry.id) ? "true" : undefined}>
            <input
              type="radio"
              name="harness-kind"
              value={entry.id}
              checked={entry.id === kind}
              disabled={existing.has(entry.id)}
              onChange={() => selectKind(entry.id)}
            />
            <span>{entry.label}</span>
            {existing.has(entry.id) ? <small>Added</small> : null}
          </label>
        ))}
      </div>
      <label className="matrix-ap-field">
        <span>Display name</span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} />
      </label>
      <div className="matrix-ap-form-grid">
        <label className="matrix-ap-field">
          <span>Model provider</span>
          <select value={providerId} onChange={(event) => selectProvider(event.target.value)} disabled={selectedCatalog.routeKind === "fixed"}>
            {snapshot.modelProviders.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
          </select>
        </label>
        <label className="matrix-ap-field">
          <span>Model</span>
          <select value={modelId} onChange={(event) => selectModel(event.target.value)} disabled={selectedCatalog.routeKind === "fixed"}>
            {provider?.models.filter((model) => model.enabled).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
        </label>
      </div>
      <label className="matrix-ap-field">
        <span>Access source</span>
        <select value={selectedSource?.id ?? ""} onChange={(event) => setSourceId(event.target.value)}>
          {eligibleSources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}
        </select>
      </label>
      <p className="matrix-ap-help">Authentication opens in a visible Terminal, browser, or secure credential prompt after the harness is added.</p>
      <div className="matrix-ap-dialog-actions">
        <button type="button" className="matrix-ap-button" onClick={onClose}>Cancel</button>
        <button type="button" className="matrix-ap-button matrix-ap-button-primary" disabled={!canAdd} onClick={add}>Add harness</button>
      </div>
    </FeatureDialog>
  );
}
