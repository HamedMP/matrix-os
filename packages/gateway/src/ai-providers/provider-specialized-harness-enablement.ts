import type { AiProviderSnapshotV3, ProviderSettingsMutation } from "@matrix-os/contracts";
import type { HarnessConfiguration } from "./provider-settings-persistence.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

export function isSpecializedHarness(harness: HarnessConfiguration): boolean {
  return harness.harness === "claude" || harness.harness === "codex";
}

/** Fixed native harnesses expose owner enablement only, never generic route writes. */
export function assertSpecializedHarnessEnablement(input: {
  harness: HarnessConfiguration;
  mutation: ProviderSettingsMutation;
  canonical: AiProviderSnapshotV3;
}): void {
  if (input.mutation.type !== "set_harness_enabled") {
    throw new ProviderSettingsStoreError("runtime_unavailable", 503);
  }
  const driverId = input.harness.harness === "claude" ? "claude_code" : "codex";
  if (input.harness.route.kind !== "fixed" || input.harness.driverId !== driverId) {
    throw new ProviderSettingsStoreError("invalid_route", 400);
  }
  // Disabling survives runtime loss. Enabling records intent, without asserting
  // remote access, changing native authentication, or acquiring a credential.
  if (input.mutation.enabled
    && input.canonical.drivers.find((driver) => driver.id === driverId)?.installState !== "installed") {
    throw new ProviderSettingsStoreError("runtime_unavailable", 503);
  }
}
