import { assertClaudeNativeLoginSelection } from "./claude-native-login-completion.js";
import type { AiProviderSnapshotV3, ProviderSettingsMutation, ProviderSettingsSnapshot } from "@matrix-os/contracts";
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
  snapshot?: ProviderSettingsSnapshot;
  claudeNativeCompletion?: boolean;
}): void {
  const nativeSelection = input.claudeNativeCompletion === true && input.harness.harness === "claude";
  if (nativeSelection) {
    if (!input.snapshot) throw new ProviderSettingsStoreError("runtime_unavailable", 503);
    assertClaudeNativeLoginSelection({ mutation: input.mutation, snapshot: input.snapshot });
  } else if (input.mutation.type !== "set_harness_enabled") {
    throw new ProviderSettingsStoreError("runtime_unavailable", 503);
  }
  const driverId = input.harness.harness === "claude" ? "claude_code" : "codex";
  if (input.harness.route.kind !== "fixed" || input.harness.driverId !== driverId) {
    throw new ProviderSettingsStoreError("invalid_route", 400);
  }
  // Disabling survives runtime loss. Enabling records intent, without asserting
  // remote access, changing native authentication, or acquiring a credential.
  if ((nativeSelection || (input.mutation.type === "set_harness_enabled" && input.mutation.enabled))
    && input.canonical.drivers.find((driver) => driver.id === driverId)?.installState !== "installed") {
    throw new ProviderSettingsStoreError("runtime_unavailable", 503);
  }
}
