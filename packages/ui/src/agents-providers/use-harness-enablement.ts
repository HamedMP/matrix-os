import { useEffect, useRef, useState } from "react";
import { isNativeGenericHarnessCredentialRoute, type ProviderAccessSource, type ProviderHarnessInstance, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { hasConfiguredConnection } from "./harness-connection.js";
import type { ProviderSettingsMutationIntent } from "./types.js";

/** Local presence permits a deliberate fresh check, never remote readiness. */
export function canRefreshNativeEnable(harness: ProviderHarnessInstance, sources: readonly ProviderAccessSource[]): boolean {
  const source = sources.find(item => item.id === harness.accessSourceId);
  return harness.installState === "installed" && isNativeGenericHarnessCredentialRoute(harness, source)
    && source?.readiness.state === "unknown" && source.localObservation?.state === "present_unverified"
    && source.eligibleModelIds.includes(harness.route.modelId);
}

export function useHarnessEnablement(input: {
  snapshot: ProviderSettingsSnapshot;
  refresh?: () => Promise<ProviderSettingsSnapshot | null>;
  mutate: (intent: ProviderSettingsMutationIntent) => Promise<boolean> | void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const lifetime = useRef(0);
  const latest = useRef(input.snapshot);
  latest.current = input.snapshot;
  const refreshScope = useRef(input.refresh);
  refreshScope.current = input.refresh;
  useEffect(() => () => { lifetime.current += 1; }, []);
  const enable = async (harness: ProviderHarnessInstance, reconnect = false) => {
    if (active.current) return;
    const generation = lifetime.current;
    const expectedRefresh = input.refresh;
    active.current = true;
    setPending(true);
    setError(null);
    try {
      const currentlyEnabled = harness.configuredEnabled ?? harness.enabled;
      if (!currentlyEnabled && (reconnect || canRefreshNativeEnable(harness, input.snapshot.accessSources))) {
        if (!input.refresh) throw new Error("Refresh unavailable");
        const fresh = await input.refresh();
        if (generation !== lifetime.current || refreshScope.current !== expectedRefresh) return;
        const current = fresh?.harnesses.find(item => item.id === harness.id);
        const visible = latest.current.harnesses.find(item => item.id === harness.id);
        if (!fresh || fresh.access.mode !== "writable" || !fresh.supportedActions.includes("set_harness_enabled")
          || latest.current.access.mode !== "writable"
          || !latest.current.supportedActions.includes("set_harness_enabled")
          || !visible || (visible.configuredEnabled ?? visible.enabled) !== currentlyEnabled
          || visible.configuredAccessSourceId !== harness.configuredAccessSourceId
          || visible.accessSourceId !== harness.accessSourceId
          || visible.selectedAccountId !== harness.selectedAccountId
          || visible.route.kind !== harness.route.kind || visible.route.providerId !== harness.route.providerId
          || visible.route.modelId !== harness.route.modelId
          || !current || current.harness !== harness.harness
          || (current.configuredEnabled ?? current.enabled) !== currentlyEnabled
          || current.selectedAccountId !== harness.selectedAccountId
          || current.configuredAccessSourceId !== harness.configuredAccessSourceId
          || current.accessSourceId !== harness.accessSourceId
          || current.route.kind !== harness.route.kind || current.route.providerId !== harness.route.providerId
          || current.route.modelId !== harness.route.modelId
          || (reconnect ? !hasConfiguredConnection({ ...current, configuredEnabled: true, enabled: true }, fresh.accessSources.find(source => source.id === current.accessSourceId)) : !canRefreshNativeEnable(current, fresh.accessSources))
          || (!reconnect && !fresh.modelProviders.some(provider => provider.id === current.route.providerId
            && provider.models.some(model => model.id === current.route.modelId && model.enabled)))) {
          throw new Error("Connection changed");
        }
        // Do not race the short observation TTL against rendering/network time.
        // The explicit mutation revalidates current credentials server-side.
      }
      if (generation !== lifetime.current || refreshScope.current !== expectedRefresh) return;
      await input.mutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: !currentlyEnabled });
    } catch (caught) {
      console.warn("[provider-settings] Enable check failed:", caught instanceof Error ? caught.name : typeof caught);
      if (generation === lifetime.current) setError("Changes were not saved. Refresh and try again.");
    } finally {
      active.current = false;
      if (generation === lifetime.current) setPending(false);
    }
  };
  return { enable, connectSaved: (harness: ProviderHarnessInstance) => enable(harness, true), pending, error, clearError: () => setError(null) };
}
