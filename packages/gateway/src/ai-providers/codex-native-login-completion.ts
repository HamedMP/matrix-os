import type { ProviderSettingsMutation, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

/** The native subscription completion may only bind its exact installed fixed client. */
export function assertCodexNativeLoginSelection(input: {
  mutation: ProviderSettingsMutation;
  snapshot: ProviderSettingsSnapshot;
}): void {
  const { mutation, snapshot } = input;
  if (mutation.type !== "select_access_source" || mutation.accessSourceId !== "owner_openai_profile"
    || mutation.enableHarness !== true || snapshot.access.mode !== "writable") {
    throw new ProviderSettingsStoreError("invalid_route", 400);
  }
  const harness = snapshot.harnesses.find(row => row.id === mutation.harnessInstanceId);
  const source = snapshot.accessSources.find(row => row.id === "owner_openai_profile"
    && row.providerId === "openai" && row.kind === "provider_account" && row.fundingKind === "owner_account");
  const account = snapshot.accounts.find(row => row.id === source?.accountId
    && row.providerId === "openai" && row.accessSourceId === source?.id
    && row.authMethod === "terminal" && row.authState === "authenticated");
  if (!harness || harness.harness !== "codex"
    || harness.installState !== "installed" || harness.route.kind !== "fixed"
    || harness.route.providerId !== "openai" || !source || !account
    || !source.eligibleModelIds.includes(harness.route.modelId)) {
    throw new ProviderSettingsStoreError("invalid_route", 400);
  }
}
