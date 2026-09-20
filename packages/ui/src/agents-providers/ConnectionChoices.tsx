import { useState } from "react";
import { isSupportedGenericHarnessCredentialRoute, type ProviderAccessSource, type ProviderHarnessInstance, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "./types.js";

/** Connection is a funding choice, never a synthetic model provider. */
export function ConnectionChoices({ snapshot, harness, gatewaySource, gatewaySelected, onUseGateway, canSetRoute, disabled, onMutate, onSetupHarness }: {
  snapshot: ProviderSettingsSnapshot;
  harness: ProviderHarnessInstance;
  gatewaySource: ProviderAccessSource | null;
  gatewaySelected: boolean;
  onUseGateway?: () => void;
  canSetRoute: boolean;
  disabled: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => Promise<boolean> | void;
  onSetupHarness?: () => Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if ((harness.harness !== "pi" && harness.harness !== "opencode") || harness.installState !== "installed") return null;
  const ownTargets = snapshot.accessSources.flatMap((source) => {
    if (source.kind === "matrix_gateway") return [];
    const provider = snapshot.modelProviders.find((candidate) => candidate.id === source.providerId);
    return provider?.models.filter((model) => model.enabled && source.eligibleModelIds.includes(model.id)
      && isSupportedGenericHarnessCredentialRoute({ ...harness, accessSourceId: source.id,
        route: { kind: "configurable", providerId: source.providerId, modelId: model.id } }, source))
      .map((model) => ({ source, model })) ?? [];
  });
  const ownTarget = ownTargets.find(({ source, model }) => source.id === harness.accessSourceId && model.id === harness.route.modelId)
    ?? ownTargets.find(({ model }) => model.id === harness.route.modelId) ?? ownTargets[0];
  const ownSelected = !gatewaySelected && ownTargets.some(({ source }) => source.id === harness.accessSourceId);
  const usingGateway = gatewaySelected && harness.enabled;
  const selectOwn = async () => {
    setFailed(false);
    setPending(true);
    try {
      const result = ownTarget && canSetRoute
        ? await onMutate({ type: "set_route", harnessInstanceId: harness.id,
          route: { kind: "configurable", providerId: ownTarget.source.providerId, modelId: ownTarget.model.id },
          accessSourceId: ownTarget.source.id, accountId: ownTarget.source.accountId,
          ...(ownTarget.source.readiness.state === "ready" ? { enableHarness: true } : {}) })
        : await onSetupHarness?.();
      if (result === false) setFailed(true);
    } catch (error) {
      console.warn("[provider-settings] Connection action failed:", error instanceof Error ? error.name : typeof error);
      setFailed(true);
    } finally { setPending(false); }
  };
  return <div className="matrix-ap-connection" role="group" aria-label={`${harness.displayName} connection`}>
    <div className="matrix-ap-connection-options">
      <button type="button" className="matrix-ap-connection-choice" aria-pressed={usingGateway}
        disabled={disabled || pending || !onUseGateway} onClick={onUseGateway}>
        <strong>{usingGateway ? "Using Matrix AI" : "Use Matrix AI"}</strong>
        <span>{gatewaySelected ? "Matrix credit · no separate login" : gatewaySource?.readiness.state === "ready" && onUseGateway ? "Matrix credit · no separate login" : "Not available for this connection"}</span>
      </button>
      <button type="button" className="matrix-ap-connection-choice" aria-pressed={ownSelected}
        disabled={disabled || pending || !(ownTarget && canSetRoute) && !onSetupHarness} onClick={() => { void selectOwn(); }}>
        <strong>Own account</strong><span>{ownSelected ? "Selected" : `Connect through ${harness.displayName}`}</span>
      </button>
    </div>
    {failed ? <p role="alert" className="matrix-ap-help">Connection could not be updated. Try again.</p> : null}
  </div>;
}
