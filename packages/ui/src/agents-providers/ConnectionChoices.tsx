import { useEffect, useRef, useState } from "react";
import { type ProviderAccessSource, type ProviderHarnessInstance, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useLocalObservationExpiry } from "../local-observation-expiry.js";
import type { ProviderSettingsMutationIntent } from "./types.js";
import { ownAccountTargets, preferredOwnAccountTarget } from "./own-account-targets.js";

/** Connection is a funding choice, never a synthetic model provider. */
export function ConnectionChoices({ snapshot, harness, gatewaySource, gatewaySelected, onUseGateway, canSetRoute, disabled, onMutate, onSetupHarness, onRefreshForConnection }: {
  snapshot: ProviderSettingsSnapshot;
  harness: ProviderHarnessInstance;
  gatewaySource: ProviderAccessSource | null;
  gatewaySelected: boolean;
  onUseGateway?: () => void;
  canSetRoute: boolean;
  disabled: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => Promise<boolean> | void;
  onSetupHarness?: () => Promise<boolean>;
  onRefreshForConnection?: () => Promise<ProviderSettingsSnapshot | null>;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const currentHarness = useRef(harness.id);
  currentHarness.current = harness.id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLocalObservationExpiry(snapshot.accessSources.map((source) => source.localObservation?.staleAfter));
  if ((harness.harness !== "pi" && harness.harness !== "opencode") || harness.installState !== "installed") return null;
  const boundTargets = ownAccountTargets(snapshot, harness, false);
  const legacyBindingUnknown = harness.configuredAccessSourceId === undefined && harness.accessSourceId === null;
  const configuredSourceId = harness.configuredAccessSourceId ?? harness.accessSourceId;
  // Own account is an explicit funding change when the saved choice is Matrix AI.
  const savedSourceId = snapshot.accessSources.some((source) => source.id === configuredSourceId && source.kind === "matrix_gateway")
    ? null : configuredSourceId;
  const savedTarget = boundTargets.find(({ source, model }) => source.id === savedSourceId
    && source.providerId === harness.route.providerId && model.id === harness.route.modelId);
  const freshTargets = ownAccountTargets(snapshot, harness);
  const ownTarget = savedSourceId !== null
    ? freshTargets.find(({ source, model }) => source.id === savedSourceId && model.id === harness.route.modelId)
    : preferredOwnAccountTarget(freshTargets, harness);
  const staleNative = savedTarget?.source.kind === "harness_profile" && savedTarget.source.readiness.state === "unknown"
    && savedTarget.source.localObservation?.state === "present_unverified" ? savedTarget : undefined;
  const ownSelected = !gatewaySelected && savedTarget !== undefined
    && (savedTarget.source.kind === "harness_profile" ? savedTarget.source.accountId === null : savedTarget.source.accountId === harness.selectedAccountId);
  const usingGateway = gatewaySelected && harness.enabled;
  const needsUpdate = !harness.enabled && snapshot.atomicConnectSupported !== true;
  const selectOwn = async () => {
    setFailed(false);
    setPending(true);
    try {
      if (legacyBindingUnknown) { setFailed(true); return; }
      const freshAtClick = ownAccountTargets(snapshot, harness);
      let target = savedSourceId !== null
        ? freshAtClick.find(({ source, model }) => source.id === savedSourceId && model.id === harness.route.modelId)
        : preferredOwnAccountTarget(freshAtClick, harness);
      if (savedSourceId !== null && !savedTarget) { setFailed(true); return; }
      let current = snapshot;
      if (!target && staleNative && canSetRoute && onRefreshForConnection) {
        const refreshed = await onRefreshForConnection();
        if (!mounted.current || currentHarness.current !== harness.id) return;
        const refreshedHarness = refreshed?.harnesses.find((candidate) => candidate.id === harness.id && candidate.harness === harness.harness);
        target = refreshed && refreshedHarness?.installState === "installed" && refreshed.access.mode === "writable"
          && refreshed.supportedActions.includes("set_route")
          && refreshedHarness.route.providerId === harness.route.providerId && refreshedHarness.route.modelId === harness.route.modelId
          && refreshedHarness.selectedAccountId === harness.selectedAccountId
          ? ownAccountTargets(refreshed, refreshedHarness).find(({ source, model }) => source.id === staleNative.source.id
            && source.providerId === staleNative.source.providerId && model.id === staleNative.model.id && source.accountId === staleNative.source.accountId
            && (refreshedHarness.configuredAccessSourceId ?? refreshedHarness.accessSourceId) === savedSourceId) : undefined;
        if (!target || !refreshed || (!refreshedHarness?.enabled && refreshed.atomicConnectSupported !== true)) {
          setFailed(true); return;
        }
        current = refreshed;
      }
      if (savedSourceId !== null && !target) { setFailed(true); return; }
      const result = target && canSetRoute
        ? await onMutate({ type: "set_route", harnessInstanceId: harness.id,
          route: { kind: "configurable", providerId: target.source.providerId, modelId: target.model.id },
          accessSourceId: target.source.id, accountId: target.source.accountId,
          ...(current.atomicConnectSupported === true ? { enableHarness: true } : {}) })
        : await onSetupHarness?.();
      if (result === false && mounted.current && currentHarness.current === harness.id) setFailed(true);
    } catch (error) {
      console.warn("[provider-settings] Connection action failed:", error instanceof Error ? error.name : typeof error);
      if (mounted.current && currentHarness.current === harness.id) setFailed(true);
    } finally { if (mounted.current) setPending(false); }
  };
  return <div className="matrix-ap-connection" role="group" aria-label={`${harness.displayName} connection`}>
    <div className="matrix-ap-connection-options">
      <button type="button" className="matrix-ap-connection-choice" aria-pressed={usingGateway}
        disabled={disabled || pending || !onUseGateway} onClick={onUseGateway}>
        <strong>{usingGateway ? "Using Matrix AI" : "Use Matrix AI"}</strong>
        <span>{gatewaySelected ? "Matrix credit · no separate login" : gatewaySource?.readiness.state === "ready" && onUseGateway ? "Matrix credit · no separate login" : "Not available for this connection"}</span>
      </button>
      <button type="button" className="matrix-ap-connection-choice" aria-pressed={ownSelected}
        disabled={disabled || pending || needsUpdate || !(ownTarget && canSetRoute) && !(staleNative && canSetRoute && onRefreshForConnection) && !(savedSourceId !== null && canSetRoute) && !onSetupHarness} onClick={() => { void selectOwn(); }}>
        <strong>Own account</strong><span>{ownSelected ? "Selected" : `Connect through ${harness.displayName}`}</span>
      </button>
    </div>
    {needsUpdate ? <p className="matrix-ap-help" role="status">Update this computer to connect and enable an agent in one step.</p> : null}
    {failed ? <p role="alert" className="matrix-ap-help">Connection could not be updated. Try again.</p> : null}
  </div>;
}
