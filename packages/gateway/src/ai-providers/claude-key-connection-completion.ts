import type { ProviderSettingsMutation, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

/** Server-only Claude key completion: after the key workflow verified and saved
 * the owner Anthropic key, fixed Claude may select exactly that key and nothing else.
 */
export function assertClaudeKeyConnectionSelection(input: {
  mutation: ProviderSettingsMutation;
  snapshot: ProviderSettingsSnapshot;
}): void {
  const { mutation, snapshot } = input;
  if (mutation.type !== "select_access_source" || mutation.accessSourceId !== "owner_anthropic_key"
    || mutation.enableHarness !== true || snapshot.access.mode !== "writable") {
    throw new ProviderSettingsStoreError("invalid_route", 400);
  }
  const harness = snapshot.harnesses.find(row => row.id === mutation.harnessInstanceId);
  const source = snapshot.accessSources.find(row => row.id === "owner_anthropic_key"
    && row.providerId === "anthropic" && row.kind === "provider_account" && row.fundingKind === "owner_api_key");
  const account = snapshot.accounts.find(row => row.id === source?.accountId
    && row.providerId === "anthropic" && row.accessSourceId === source?.id && row.authMethod === "api_key");
  if (!harness || harness.harness !== "claude"
    || harness.installState !== "installed" || harness.route.kind !== "fixed"
    || harness.route.providerId !== "anthropic" || !source || !account
    || !source.eligibleModelIds.includes(harness.route.modelId)) {
    throw new ProviderSettingsStoreError("invalid_route", 400);
  }
}
