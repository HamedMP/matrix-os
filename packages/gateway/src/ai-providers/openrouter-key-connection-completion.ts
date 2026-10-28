import type { ProviderSettingsMutation, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

/** Trusted completion after the shared OpenRouter key has been verified and staged. */
export function assertOpenRouterKeyConnectionSelection(input: {
  mutation: ProviderSettingsMutation;
  snapshot: ProviderSettingsSnapshot;
  modelId: string;
  credentialGeneration: string;
}): void {
  const { mutation, snapshot, modelId, credentialGeneration } = input;
  if (mutation.type !== "select_access_source" || mutation.accessSourceId !== "owner_openrouter"
    || mutation.enableHarness !== true
    || snapshot.access.mode !== "writable") throw new ProviderSettingsStoreError("invalid_route", 400);
  const harness = snapshot.harnesses.find(row => row.id === mutation.harnessInstanceId);
  const source = snapshot.accessSources.find(row => row.id === "owner_openrouter"
    && row.providerId === "openrouter" && row.kind === "provider_account" && row.fundingKind === "owner_api_key");
  const account = snapshot.accounts.find(row => row.id === source?.accountId
    && row.providerId === "openrouter" && row.accessSourceId === source?.id && row.authMethod === "api_key");
  if (!harness || !["claude", "codex"].includes(harness.harness)
    || harness.installState !== "installed" || !source || !account
    || source.credentialGeneration !== credentialGeneration
    || source.readiness.state !== "ready" || account.authState !== "authenticated"
    || !source.eligibleModelIds.includes(modelId)) {
    throw new ProviderSettingsStoreError("invalid_route", 400);
  }
}

