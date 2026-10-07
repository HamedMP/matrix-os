import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { ProviderSettingsController } from "./provider-settings-controller.js";
import { isNativeGenericHarnessCredentialRoute } from "@matrix-os/contracts";

function nextExpiry(snapshot: ProviderSettingsSnapshot | null): number | null {
  const expires = snapshot?.harnesses.flatMap(harness => {
    const source = snapshot.accessSources.find(candidate => candidate.id === harness.accessSourceId);
    if (harness.harness !== "hermes" || harness.installState !== "installed" || harness.authState !== "unknown"
      || (harness.configuredEnabled ?? harness.enabled) === false || !source
      || ["invalid", "expired", "auth_required"].includes(source.readiness.state)
      || !isNativeGenericHarnessCredentialRoute(harness, source)) return [];
    const observation = source.localObservation ?? harness.localObservation;
    const checked = Date.parse(observation?.checkedAt ?? "");
    const expires = Date.parse(observation?.staleAfter ?? "");
    return observation?.state === "present_unverified" && Number.isFinite(checked) && checked <= Date.now()
      && Number.isFinite(expires) && expires > checked && expires - checked <= 5000 ? [expires] : [];
  }) ?? [];
  return expires.length ? Math.min(...expires) : null;
}

/** Mounted, visible Settings only; no mutations, catalog churn or infinite retries. */
export function startVisibleNativeObservationRenewal(controller: ProviderSettingsController): () => void {
  if (typeof document === "undefined") return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let failures = 0;
  let disposed = false;
  let lastSnapshot = controller.getState().snapshot;
  const visible = () => document.visibilityState === "visible";
  const schedule = () => {
    if (disposed || !visible() || timer || request || failures >= 3) return;
    const expiry = nextExpiry(controller.getState().snapshot);
    if (expiry === null) return;
    // Leave room for transport; base timing on server expiry, not receipt time.
    const delay = failures ? Math.min(10000, 2000 * 2 ** (failures - 1)) : Math.max(1000, expiry - Date.now() - 1000);
    timer = setTimeout(() => { timer = undefined; void renew(); }, Math.min(30000, delay));
  };
  const renew = async () => {
    if (disposed || !visible()) return;
    if (controller.getState().busy) { schedule(); return; }
    const active = new AbortController(); request = active;
    const timeout = setTimeout(() => active.abort(), 15000);
    try {
      const accepted = await controller.renewLocalObservation(active.signal);
      if (!disposed && visible()) {
        const expiry = nextExpiry(controller.getState().snapshot);
        failures = accepted && (expiry === null || expiry > Date.now() + 1000) ? 0 : failures + 1;
      }
    } finally {
      clearTimeout(timeout);
      if (request === active) request = undefined;
      schedule();
    }
  };
  const unsubscribe = controller.subscribe(() => {
    const current = controller.getState().snapshot;
    if (current !== lastSnapshot) {
      lastSnapshot = current; if (!request) failures = 0;
      clearTimeout(timer); timer = undefined;
    }
    schedule();
  });
  const onVisibility = () => {
    clearTimeout(timer); timer = undefined;
    if (!visible()) request?.abort();
    else { failures = 0; schedule(); }
  };
  document.addEventListener("visibilitychange", onVisibility);
  schedule();
  return () => { disposed = true; clearTimeout(timer); request?.abort(); unsubscribe(); document.removeEventListener("visibilitychange", onVisibility); };
}
