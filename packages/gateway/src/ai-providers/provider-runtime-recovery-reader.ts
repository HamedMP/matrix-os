import type { ProviderSettingsRuntimeCoordinator } from "./provider-settings-coordinators.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

/** One in-flight retry; the coordinator retains its serialized compensation/CAS ownership. */
export function createProviderRuntimeRecoveryReader(
  coordinator: ProviderSettingsRuntimeCoordinator | undefined,
  timeoutMs = 5_000,
) {
  let pending: Promise<void> | null = null;
  const deadlineMs = Math.max(1, Math.min(timeoutMs, 5_000));
  return async (refresh: boolean): Promise<void> => {
    if (!coordinator || coordinator.isRecoveryReady()) return;
    if (!refresh) throw new ProviderSettingsStoreError("runtime_unavailable", 503);
    if (!pending) {
      const attempt = Promise.resolve().then(() => coordinator.reconcilePending()).catch((error: unknown) => {
        console.warn("[provider-settings] Explicit runtime recovery unavailable:",
          error instanceof Error ? error.name : "UnknownError");
        throw new ProviderSettingsStoreError("runtime_unavailable", 503);
      });
      pending = attempt.finally(() => { pending = null; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderSettingsStoreError("runtime_unavailable", 503)), deadlineMs);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // A completed reconciliation must affirm readiness before returning ordinary truth.
    if (!coordinator.isRecoveryReady()) throw new ProviderSettingsStoreError("runtime_unavailable", 503);
  };
}
