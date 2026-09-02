import { useEffect, useState } from "react";
import type {
  ProviderAccessSource,
  ProviderAccentColor,
  ProviderHarnessInstance,
  ProviderModelProvider,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "./types.js";
import { authLabel, titleCase } from "./utils.js";

const ACCENTS: ProviderAccentColor[] = ["blue", "green", "orange", "red", "purple", "cyan", "teal"];

function providerFor(snapshot: ProviderSettingsSnapshot, harness: ProviderHarnessInstance): ProviderModelProvider | null {
  return snapshot.modelProviders.find((provider) => provider.id === harness.route.providerId) ?? null;
}

function sourceSupportsModel(
  snapshot: ProviderSettingsSnapshot,
  source: ProviderAccessSource,
  modelId: string,
): boolean {
  if (!source.eligibleModelIds.includes(modelId)) return false;
  if (source.kind !== "matrix_gateway") return true;
  return snapshot.gatewayPolicy?.accessSourceId === source.id
    && snapshot.gatewayPolicy.allowedModelIds.includes(modelId);
}

function routeTargetForProvider(snapshot: ProviderSettingsSnapshot, provider: ProviderModelProvider) {
  for (const model of provider.models) {
    if (!model.enabled) continue;
    const source = snapshot.accessSources.find((candidate) =>
      candidate.providerId === provider.id && sourceSupportsModel(snapshot, candidate, model.id));
    if (source) return { model, source };
  }
  return null;
}

export function HarnessEditor({
  snapshot,
  harness,
  disabled,
  canUpdate,
  canEnable,
  canSetRoute,
  canSelectSource,
  canSelectAccount,
  onMutate,
}: {
  snapshot: ProviderSettingsSnapshot;
  harness: ProviderHarnessInstance;
  disabled: boolean;
  canUpdate: boolean;
  canEnable: boolean;
  canSetRoute: boolean;
  canSelectSource: boolean;
  canSelectAccount: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
}) {
  const [displayName, setDisplayName] = useState(harness.displayName);
  useEffect(() => setDisplayName(harness.displayName), [harness.displayName, harness.id]);
  const provider = providerFor(snapshot, harness);
  const model = provider?.models.find((candidate) => candidate.id === harness.route.modelId) ?? null;
  const accessSource = snapshot.accessSources.find((source) => source.id === harness.accessSourceId) ?? null;
  const account = snapshot.accounts.find((candidate) => candidate.id === harness.selectedAccountId) ?? null;
  const sources = snapshot.accessSources.filter((source) => source.providerId === harness.route.providerId
    && sourceSupportsModel(snapshot, source, harness.route.modelId));
  const accounts = snapshot.accounts.filter((candidate) => {
    if (!harness.accountIds.includes(candidate.id)) return false;
    const candidateSource = snapshot.accessSources.find((source) => source.id === candidate.accessSourceId);
    return candidateSource?.providerId === harness.route.providerId
      && sourceSupportsModel(snapshot, candidateSource, harness.route.modelId);
  });
  const gatewaySource = sources.find((source) => source.kind === "matrix_gateway") ?? null;
  const routeProviders = snapshot.modelProviders.filter((candidate) => routeTargetForProvider(snapshot, candidate) !== null);
  const mutableRoute = harness.route.kind === "configurable";

  const changeProvider = (nextProviderId: string) => {
    const nextProvider = snapshot.modelProviders.find((candidate) => candidate.id === nextProviderId);
    const target = nextProvider ? routeTargetForProvider(snapshot, nextProvider) : null;
    if (!target) return;
    onMutate({
      type: "set_route",
      harnessInstanceId: harness.id,
      route: { kind: "configurable", providerId: nextProviderId, modelId: target.model.id },
      accessSourceId: target.source.id,
      accountId: target.source.accountId,
    });
  };

  const changeModel = (nextModelId: string) => {
    const targetSource = snapshot.accessSources.find((candidate) =>
      candidate.id === harness.accessSourceId
      && candidate.providerId === harness.route.providerId
      && sourceSupportsModel(snapshot, candidate, nextModelId))
      ?? snapshot.accessSources.find((candidate) =>
        candidate.providerId === harness.route.providerId
        && sourceSupportsModel(snapshot, candidate, nextModelId));
    if (!targetSource) return;
    onMutate({
      type: "set_route",
      harnessInstanceId: harness.id,
      route: { kind: "configurable", providerId: harness.route.providerId, modelId: nextModelId },
      accessSourceId: targetSource.id,
      accountId: targetSource.accountId,
    });
  };

  return (
    <section className="matrix-ap-editor" aria-labelledby="matrix-ap-harness-title">
      <div className="matrix-ap-editor-head">
        <div className="matrix-ap-title-lockup">
          <span className="matrix-ap-harness-mark" data-accent={harness.accentColor ?? "none"} aria-hidden="true">
            {harness.displayName.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h2 id="matrix-ap-harness-title">{harness.displayName}</h2>
            <p>{titleCase(harness.harness)}{harness.version ? ` · ${harness.version}` : ""}</p>
          </div>
        </div>
        <label className="matrix-ap-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label={`Enable ${harness.displayName}`}
            checked={harness.enabled}
            disabled={disabled || !canEnable || harness.installState !== "installed"}
            onChange={() => onMutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: !harness.enabled })}
          />
          <span aria-hidden="true" />
        </label>
      </div>

      <div className="matrix-ap-state-strip">
        <span data-state={harness.connectivity}>{titleCase(harness.connectivity)}</span>
        <span>{titleCase(harness.installState)}</span>
        <span>{authLabel(harness.authState)}</span>
        {harness.activeChatCount > 0 ? <span>{harness.activeChatCount} active chat{harness.activeChatCount === 1 ? "" : "s"}</span> : null}
      </div>

      {harness.installState !== "installed" ? (
        <div className="matrix-ap-notice" data-tone="warning">
          <div><strong>{harness.displayName} is not installed</strong><span>Install this harness from Terminal before enabling it here.</span></div>
          <button type="button" className="matrix-ap-button" disabled aria-label={`Install ${harness.displayName}`} title="Harness installation is not available from this runtime">Install unavailable</button>
        </div>
      ) : null}
      {harness.connectivity === "offline" ? (
        <div className="matrix-ap-notice" data-tone="warning"><strong>Offline</strong><span>Saved settings are visible, but changes may not reach this computer.</span></div>
      ) : null}

      <div className="matrix-ap-panel">
        <span className="matrix-ap-eyebrow">Instance</span>
        <div className="matrix-ap-form-grid matrix-ap-form-grid-name">
          <label className="matrix-ap-field">
            <span>Display name</span>
            <input
              value={displayName}
              maxLength={120}
              disabled={disabled || !canUpdate}
              onChange={(event) => setDisplayName(event.target.value)}
              onBlur={() => {
                const next = displayName.trim();
                if (next && next !== harness.displayName) onMutate({ type: "update_harness", harnessInstanceId: harness.id, displayName: next });
              }}
            />
          </label>
          <fieldset className="matrix-ap-accents" disabled={disabled || !canUpdate}>
            <legend>Accent color</legend>
            <div>
              {ACCENTS.map((accent) => (
                <button
                  key={accent}
                  type="button"
                  className="matrix-ap-accent"
                  data-accent={accent}
                  data-selected={accent === harness.accentColor ? "true" : undefined}
                  aria-label={`Use ${accent} accent`}
                  onClick={() => onMutate({ type: "update_harness", harnessInstanceId: harness.id, accentColor: accent })}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </div>

      <div className="matrix-ap-panel">
        <div className="matrix-ap-panel-head">
          <div><span className="matrix-ap-eyebrow">Model route</span><h3>Provider and model</h3></div>
          {!mutableRoute ? <span className="matrix-ap-fixed-tag">Fixed by {harness.displayName}</span> : null}
        </div>
        <div className="matrix-ap-form-grid">
          <label className="matrix-ap-field">
            <span>Model provider</span>
            <select
              aria-label="Model provider"
              value={harness.route.providerId}
              disabled={disabled || !canSetRoute || !mutableRoute}
              title={!canSetRoute ? "Changing the model route is not available" : undefined}
              onChange={(event) => changeProvider(event.target.value)}
            >
              {routeProviders.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
            </select>
          </label>
          <label className="matrix-ap-field">
            <span>Model</span>
            <select
              aria-label="Model"
              value={harness.route.modelId}
              disabled={disabled || !canSetRoute || !mutableRoute}
              title={!canSetRoute ? "Changing the model route is not available" : undefined}
              onChange={(event) => changeModel(event.target.value)}
            >
              {provider?.models
                .filter((candidate) => candidate.enabled && snapshot.accessSources.some((source) =>
                  source.providerId === harness.route.providerId && sourceSupportsModel(snapshot, source, candidate.id)))
                .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="matrix-ap-panel">
        <span className="matrix-ap-eyebrow">Signal path</span>
        <div className="matrix-ap-signal-path" data-testid="provider-signal-path">
          <span><small>Harness</small><strong>{harness.displayName}</strong></span>
          <i aria-hidden="true">›</i>
          <span><small>Model</small><strong>{model?.displayName ?? harness.route.modelId}</strong></span>
          <i aria-hidden="true">›</i>
          <span><small>Access</small><strong>{accessSource?.displayName ?? "Not selected"}</strong></span>
        </div>
        <div className="matrix-ap-form-grid">
          <label className="matrix-ap-field">
            <span>Access source</span>
            <select
              aria-label="Access source"
              value={harness.accessSourceId ?? ""}
              disabled={disabled || !canSelectSource}
              title={!canSelectSource ? "Changing the access source is not available" : undefined}
              onChange={(event) => onMutate({ type: "select_access_source", harnessInstanceId: harness.id, accessSourceId: event.target.value })}
            >
              <option value="" disabled>Select an access source</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}
            </select>
          </label>
          <label className="matrix-ap-field">
            <span>Account</span>
            <select
              aria-label="Account"
              value={harness.selectedAccountId ?? ""}
              disabled={disabled || !canSelectAccount || (accounts.length === 0 && gatewaySource === null)}
              title={!canSelectAccount ? "Changing the account is not available" : undefined}
              onChange={(event) => {
                const accountId = event.target.value;
                if (accountId !== "" && canSelectAccount) {
                  onMutate({ type: "select_account", harnessInstanceId: harness.id, accountId });
                } else if (accountId === "" && gatewaySource !== null && canSelectSource) {
                  onMutate({ type: "select_access_source", harnessInstanceId: harness.id, accessSourceId: gatewaySource.id });
                }
              }}
            >
              {gatewaySource ? <option value="">Matrix gateway / no account</option> : <option value="" disabled>Select an account</option>}
              {accounts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
            </select>
          </label>
        </div>
        {account ? <p className="matrix-ap-help">Selected account: {account.displayName}</p> : null}
        {!canSetRoute || !canSelectSource || !canSelectAccount ? (
          <p className="matrix-ap-help">Some routing controls are unavailable in this runtime.</p>
        ) : null}
      </div>
    </section>
  );
}
