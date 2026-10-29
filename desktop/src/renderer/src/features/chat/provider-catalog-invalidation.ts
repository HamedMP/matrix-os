import { MATRIX_CHATGPT_PLAN_INSTANCE_ID, MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, type ProviderSettingsSnapshot, type ProviderWorkflow } from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "@matrix-os/ui";
import { desktopProviderCatalogCache } from "./provider-catalog-coordinator";
import { useConnection } from "../../stores/connection";

/** Device-plan receipts cannot invalidate the independent native Codex account. */
export function invalidateDesktopChatgptPlanCatalog(identityKey: string): void {
  useConnection.getState().invalidateProviderCatalog(identityKey,
    [MATRIX_CHATGPT_PLAN_INSTANCE_ID, MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID], false);
}

/** Only explicit saved harness enablement/revocation has a proven narrow scope.
 * The gateway applies these settings by harness kind, not Settings row ID.
 * Account, source, funding and inventory changes conservatively suspend all.
 */
export function invalidateDesktopProviderCatalog(
  identityKey: string,
  intent?: ProviderSettingsMutationIntent,
  previousSnapshot?: ProviderSettingsSnapshot,
  loginReceipt?: ProviderWorkflow,
): void {
  if (loginReceipt) {
    if (loginReceipt.kind !== "login" || loginReceipt.state !== "succeeded") return;
    const harness = previousSnapshot?.harnesses.find(value => value.id === loginReceipt.harnessInstanceId);
    if (!harness) return;
    const catalog = desktopProviderCatalogCache.getSnapshot().catalog;
    if (!desktopProviderCatalogCache.acceptLoginReceipt(identityKey, `${harness.id}:${loginReceipt.id}`)) return;
    const driverKind = harness.harness === "claude" ? "claude_code" : harness.harness;
    const affected = catalog?.instances.filter(instance => instance.driverKind === driverKind).map(instance => instance.id) ?? [];
    useConnection.getState().invalidateProviderCatalog(identityKey, affected, false);
    return;
  }
  const harness = intent && (intent.type === "set_harness_enabled" || intent.type === "remove_harness")
    ? previousSnapshot?.harnesses.find(value => value.id === intent.harnessInstanceId) : undefined;
  const catalog = desktopProviderCatalogCache.getSnapshot().catalog;
  const affected = harness && catalog ? catalog.instances.filter(instance =>
    instance.driverKind === (harness.harness === "claude" ? "claude_code" : harness.harness)).map(instance => instance.id) : null;
  // An absent projection is not evidence that no routes were affected.
  useConnection.getState().invalidateProviderCatalog(identityKey, affected?.length ? affected : null);
}
