import { useEffect, useState } from "react";
import type {
  ProviderAccessSource,
  ProviderAccentColor,
  ProviderHarnessInstance,
  ProviderModelProvider,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { isSupportedGenericHarnessCredentialRoute } from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "./types.js";

const ACCENTS: ProviderAccentColor[] = ["blue", "green", "orange", "red", "purple", "cyan", "teal"];

function unavailableRouteLabel(reference: string): string {
  const leaf = reference.split(/[/:]/).at(-1) ?? reference;
  const label = leaf.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? `${label.slice(0, 1).toUpperCase()}${label.slice(1)}` : reference;
}

function providerFor(snapshot: ProviderSettingsSnapshot, harness: ProviderHarnessInstance): ProviderModelProvider | null {
  return snapshot.modelProviders.find((provider) => provider.id === harness.route.providerId) ?? null;
}

function sourceSupportsModel(
  snapshot: ProviderSettingsSnapshot,
  source: ProviderAccessSource,
  modelId: string,
  harness?: ProviderHarnessInstance,
): boolean {
  if (!source.eligibleModelIds.includes(modelId)) return false;
  if (harness && !isSupportedGenericHarnessCredentialRoute({
      ...harness,
      accessSourceId: source.id,
      route: { kind: "configurable", providerId: source.providerId, modelId },
    }, source)) return false;
  if (source.kind !== "matrix_gateway") return true;
  return snapshot.gatewayPolicy?.accessSourceId === source.id
    && snapshot.gatewayPolicy.allowedModelIds.includes(modelId);
}

function routeTargetForProvider(snapshot: ProviderSettingsSnapshot, provider: ProviderModelProvider, harness: ProviderHarnessInstance) {
  for (const model of provider.models) {
    if (!model.enabled) continue;
    const source = snapshot.accessSources.find((candidate) =>
      candidate.providerId === provider.id && sourceSupportsModel(snapshot, candidate, model.id, harness));
    if (source) return { model, source };
  }
  return null;
}

export function HarnessEditor({
  snapshot,
  harness,
  disabled,
  canUpdate,
  canSetRoute,
  canSelectSource,
  canSelectAccount,
  onMutate,
  onRefresh,
}: {
  snapshot: ProviderSettingsSnapshot;
  harness: ProviderHarnessInstance;
  disabled: boolean;
  canUpdate: boolean;
  canSetRoute: boolean;
  canSelectSource: boolean;
  canSelectAccount: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
  onRefresh: () => void;
}) {
  const [displayName, setDisplayName] = useState(harness.displayName);
  useEffect(() => setDisplayName(harness.displayName), [harness.displayName, harness.id]);
  const provider = providerFor(snapshot, harness);
  const model = provider?.models.find((candidate) => candidate.id === harness.route.modelId) ?? null;
  const accessSource = snapshot.accessSources.find((source) => source.id === harness.accessSourceId) ?? null;
  const savedSourceUnsupported = accessSource !== null && !isSupportedGenericHarnessCredentialRoute(harness, accessSource);
  const account = snapshot.accounts.find((candidate) => candidate.id === harness.selectedAccountId) ?? null;
  const sources = snapshot.accessSources.filter((source) => source.providerId === harness.route.providerId
    && sourceSupportsModel(snapshot, source, harness.route.modelId, harness));
  const accounts = snapshot.accounts.filter((candidate) => {
    if (!harness.accountIds.includes(candidate.id)) return false;
    const candidateSource = snapshot.accessSources.find((source) => source.id === candidate.accessSourceId);
    return candidateSource?.providerId === harness.route.providerId
      && sourceSupportsModel(snapshot, candidateSource, harness.route.modelId, harness);
  });
  const gatewaySource = sources.find((source) => source.kind === "matrix_gateway") ?? null;
  const routeProviders = snapshot.modelProviders.filter((candidate) =>
    candidate.id === harness.route.providerId
    || routeTargetForProvider(snapshot, candidate, harness) !== null);
  const mutableRoute = harness.route.kind === "configurable";
  const routeUnavailable = harness.routeAvailability === "catalog_unavailable";

  const changeProvider = (nextProviderId: string) => {
    const nextProvider = snapshot.modelProviders.find((candidate) => candidate.id === nextProviderId);
    const target = nextProvider ? routeTargetForProvider(snapshot, nextProvider, harness) : null;
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
      && sourceSupportsModel(snapshot, candidate, nextModelId, harness))
      ?? snapshot.accessSources.find((candidate) =>
        candidate.providerId === harness.route.providerId
        && sourceSupportsModel(snapshot, candidate, nextModelId, harness));
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
    <section className="matrix-ap-editor" aria-label={`${harness.displayName} configuration`}>
      {savedSourceUnsupported ? <div className="matrix-ap-notice" data-tone="warning"><strong>Choose a supported connection</strong></div> : null}
      {harness.installState !== "installed" ? (
        <div className="matrix-ap-notice" data-tone="warning">
          <div><strong>{harness.displayName} {harness.installState === "missing" ? "is not installed" : "installation needs checking"}</strong><span>Install from this computer’s Terminal, then check again.</span></div>
        </div>
      ) : null}
      {harness.connectivity !== "online" ? (
        <div className="matrix-ap-notice" data-tone="warning"><strong>Connection not verified</strong><button type="button" className="matrix-ap-button" disabled={disabled} onClick={onRefresh}>Check again</button></div>
      ) : null}
      {routeUnavailable ? (
        <div className="matrix-ap-notice" data-tone="warning">
          <strong>Saved model catalog unavailable</strong>
          <span>Choose an available model or check again.</span>
        </div>
      ) : null}

      <div className="matrix-ap-panel">
        <div className="matrix-ap-panel-head">
          <div><h3>Choose the model</h3></div>
          {!mutableRoute ? <span className="matrix-ap-fixed-tag">Fixed by {harness.displayName}</span> : null}
        </div>
        <div className="matrix-ap-form-grid">
          <label className="matrix-ap-field">
            <span>Provider</span>
            {canSetRoute && mutableRoute ? <select
              aria-label="Model provider"
              value={harness.route.providerId}
              disabled={disabled || !canSetRoute || !mutableRoute}
              title={!canSetRoute ? "Changing the model route is not available" : undefined}
              onChange={(event) => changeProvider(event.target.value)}
            >
              {provider === null ? (
                <option value={harness.route.providerId}>{unavailableRouteLabel(harness.route.providerId)} · Unavailable</option>
              ) : null}
              {routeProviders.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
            </select> : <span className="matrix-ap-readonly-value">{provider?.displayName ?? `${unavailableRouteLabel(harness.route.providerId)} · Unavailable`}</span>}
          </label>
          <label className="matrix-ap-field">
            <span>Model</span>
            {canSetRoute && mutableRoute ? <select
              aria-label="Model"
              value={harness.route.modelId}
              disabled={disabled || !canSetRoute || !mutableRoute}
              title={!canSetRoute ? "Changing the model route is not available" : undefined}
              onChange={(event) => changeModel(event.target.value)}
            >
              {model === null ? (
                <option value={harness.route.modelId}>{unavailableRouteLabel(harness.route.modelId)} · Unavailable</option>
              ) : null}
              {provider?.models
                .filter((candidate) => candidate.enabled && (
                  candidate.id === harness.route.modelId
                  || snapshot.accessSources.some((source) => source.providerId === harness.route.providerId
                    && sourceSupportsModel(snapshot, source, candidate.id, harness))))
                .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
            </select> : <span className="matrix-ap-readonly-value">{model?.displayName ?? `${unavailableRouteLabel(harness.route.modelId)} · Unavailable`}</span>}
          </label>
        </div>
      </div>

      <details className="matrix-ap-advanced">
        <summary>Advanced settings</summary>
      <div className="matrix-ap-panel">
        <div className="matrix-ap-panel-head">
          <div><h3>Access</h3></div>
        </div>
        <div className="matrix-ap-signal-path" data-testid="provider-signal-path">
          <span><small>Harness</small><strong>{harness.displayName}</strong></span>
          <i aria-hidden="true">›</i>
          <span><small>Model</small><strong>{model?.displayName ?? harness.route.modelId}</strong></span>
          <i aria-hidden="true">›</i>
          <span><small>Paid through</small><strong>{savedSourceUnsupported ? "Saved access unavailable" : accessSource?.displayName ?? "Not selected"}</strong></span>
        </div>
        <div className="matrix-ap-form-grid">
          <label className="matrix-ap-field">
            <span>Paid through</span>
            {canSelectSource && sources.length > 0 ? <select
              aria-label="Paid through"
              value={harness.accessSourceId ?? ""}
              disabled={disabled || !canSelectSource}
              title={!canSelectSource ? "Changing the access source is not available" : undefined}
              onChange={(event) => onMutate({ type: "select_access_source", harnessInstanceId: harness.id, accessSourceId: event.target.value })}
            >
              <option value="" disabled>Select an access source</option>
              {savedSourceUnsupported ? <option value={harness.accessSourceId ?? ""} disabled>Saved access unavailable</option> : null}
              {sources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}
            </select> : <span className="matrix-ap-readonly-value">{savedSourceUnsupported ? "Saved access unavailable" : accessSource?.displayName ?? "No access connected"}</span>}
          </label>
          {accessSource?.kind === "harness_profile" ? (
            <div className="matrix-ap-field">
              <span>Authentication</span>
              <div className="matrix-ap-readonly-value">Managed by {harness.displayName}</div>
            </div>
          ) : (
            <label className="matrix-ap-field">
              <span>Account</span>
              {canSelectAccount && (accounts.length > 0 || gatewaySource !== null) ? <select
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
              </select> : <span className="matrix-ap-readonly-value">{savedSourceUnsupported ? "Choose a supported connection" : accessSource?.kind === "matrix_gateway" ? "Included with Matrix AI — no separate login" : account?.displayName ?? "No account connected"}</span>}
            </label>
          )}
        </div>
        <p className="matrix-ap-help">{harness.harness === "hermes" || harness.harness === "openclaw"
          ? "Connect your own provider account in Terminal. Matrix AI funding is not supported for this agent yet."
          : "Use Matrix AI credit or connect your own account. Only supported connections appear here."}</p>
        {accessSource?.kind === "harness_profile" ? (
          <p className="matrix-ap-help">{harness.displayName} manages authentication for this route. Add or switch accounts from its visible Terminal flow.</p>
        ) : null}
        {account ? <p className="matrix-ap-help">Selected account: {account.displayName}</p> : null}
      </div>
        <div className="matrix-ap-panel matrix-ap-form-grid matrix-ap-form-grid-name">
          <label className="matrix-ap-field">
            <span>Display name</span>
            <input value={displayName} maxLength={120} disabled={disabled || !canUpdate}
              onChange={(event) => setDisplayName(event.target.value)}
              onBlur={() => {
                const next = displayName.trim();
                if (next && next !== harness.displayName) onMutate({ type: "update_harness", harnessInstanceId: harness.id, displayName: next });
              }} />
          </label>
          <fieldset className="matrix-ap-accents" disabled={disabled || !canUpdate}>
            <legend>Accent color</legend>
            <div>{ACCENTS.map((accent) => (
              <button key={accent} type="button" className="matrix-ap-accent" data-accent={accent}
                data-selected={accent === harness.accentColor ? "true" : undefined}
                aria-label={`Use ${accent} accent`}
                onClick={() => onMutate({ type: "update_harness", harnessInstanceId: harness.id, accentColor: accent })} />
            ))}</div>
          </fieldset>
        </div>
      </details>
    </section>
  );
}
