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
  const ownTarget = preferredOwnAccountTarget(ownAccountTargets(snapshot, harness), harness);
  const boundTargets = ownAccountTargets(snapshot, harness, false);
  const staleNative = preferredOwnAccountTarget(boundTargets.filter(({ source }) => source.kind === "harness_profile"
    && source.readiness.state === "unknown" && source.localObservation?.state === "present_unverified"), harness);
  const ownSelected = !gatewaySelected && boundTargets.some(({ source, model }) => source.id === harness.accessSourceId
    && model.id === harness.route.modelId && source.accountId === harness.selectedAccountId);
  const usingGateway = gatewaySelected && harness.enabled;
  const needsUpdate = !harness.enabled && snapshot.atomicConnectSupported !== true;
  const selectOwn = async () => {
    setFailed(false);
    setPending(true);
    try {
      let target = preferredOwnAccountTarget(ownAccountTargets(snapshot, harness), harness);
      let current = snapshot;
      if (!target && staleNative && canSetRoute && onRefreshForConnection) {
        const refreshed = await onRefreshForConnection();
        if (!mounted.current || currentHarness.current !== harness.id) return;
        const refreshedHarness = refreshed?.harnesses.find((candidate) => candidate.id === harness.id && candidate.harness === harness.harness);
        target = refreshed && refreshedHarness?.installState === "installed" && refreshed.access.mode === "writable"
          && refreshed.supportedActions.includes("set_route")
          ? ownAccountTargets(refreshed, refreshedHarness).find(({ source, model }) => source.id === staleNative.source.id
            && source.providerId === staleNative.source.providerId && model.id === staleNative.model.id) : undefined;
        if (!target || !refreshed || (!refreshedHarness?.enabled && refreshed.atomicConnectSupported !== true)) {
          setFailed(true); return;
        }
        current = refreshed;
      }
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
        disabled={disabled || pending || needsUpdate || !(ownTarget && canSetRoute) && !(staleNative && canSetRoute && onRefreshForConnection) && !onSetupHarness} onClick={() => { void selectOwn(); }}>
        <strong>Own account</strong><span>{ownSelected ? "Selected" : `Connect through ${harness.displayName}`}</span>
      </button>
    </div>
    {needsUpdate ? <p className="matrix-ap-help" role="status">Update this computer to connect and enable an agent in one step.</p> : null}
    {failed ? <p role="alert" className="matrix-ap-help">Connection could not be updated. Try again.</p> : null}
  </div>;
}
