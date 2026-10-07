import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "@matrix-os/ui";
import { desktopProviderCatalogCache } from "./provider-catalog-coordinator";
import { useConnection } from "../../stores/connection";

/** Only explicit saved harness enablement/revocation has a proven narrow scope.
 * The gateway applies these settings by harness kind, not Settings row ID.
 * Account, source, funding and inventory changes conservatively suspend all.
 */
export function invalidateDesktopProviderCatalog(
  identityKey: string,
  intent?: ProviderSettingsMutationIntent,
  previousSnapshot?: ProviderSettingsSnapshot,
): void {
  const harness = intent && (intent.type === "set_harness_enabled" || intent.type === "remove_harness")
    ? previousSnapshot?.harnesses.find(value => value.id === intent.harnessInstanceId) : undefined;
  const catalog = desktopProviderCatalogCache.getSnapshot().catalog;
  const affected = harness && catalog ? catalog.instances.filter(instance =>
    instance.driverKind === (harness.harness === "claude" ? "claude_code" : harness.harness)).map(instance => instance.id) : null;
  // An absent projection is not evidence that no routes were affected.
  useConnection.getState().invalidateProviderCatalog(identityKey, affected?.length ? affected : null);
}
