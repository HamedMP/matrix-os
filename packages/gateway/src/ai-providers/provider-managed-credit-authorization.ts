import type { Context } from "hono";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

/** Only startup-owned runtime identity and the authenticated principal grant access. */
export function createManagedCreditOwnerAuthorization(
  runtimeOwnerId: string | undefined,
  getPrincipal: (context: Context) => { userId: string },
): (context: Context) => boolean {
  return context => {
    if (!runtimeOwnerId) throw new ProviderSettingsStoreError("configuration_unavailable", 503);
    return getPrincipal(context).userId === runtimeOwnerId;
  };
}
