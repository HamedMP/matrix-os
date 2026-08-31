import type {
  AiProviderSnapshotV3,
  ProviderSettingsMutation,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";
import {
  providerDriverId,
  type ProviderSettingsConfiguration,
} from "./provider-settings-persistence.js";
import { resolveProviderSettingsDriverId } from "./provider-settings-driver-id.js";

export type ProviderConfigurationMutation = Exclude<ProviderSettingsMutation,
  | { type: "start_login" }
  | { type: "logout_account" }
  | { type: "remove_account" }
  | { type: "reassign_account" }>;

export function applyProviderConfigurationMutation(input: {
  mutation: ProviderSettingsMutation;
  config: ProviderSettingsConfiguration;
  canonical: AiProviderSnapshotV3;
  snapshot: ProviderSettingsSnapshot;
  id: () => string;
}): boolean {
  const mutation = input.mutation as ProviderConfigurationMutation;
  const harness = "harnessInstanceId" in mutation
    ? input.config.harnesses.find((candidate) => candidate.id === mutation.harnessInstanceId)
    : undefined;

  switch (mutation.type) {
    case "add_harness": {
      if (input.config.harnesses.length >= 128) {
        throw new ProviderSettingsStoreError("invalid_request", 400);
      }
      const source = input.snapshot.accessSources.find((candidate) => candidate.id === mutation.accessSourceId);
      const account = mutation.accountId === null
        ? null
        : input.snapshot.accounts.find((candidate) => candidate.id === mutation.accountId) ?? null;
      const gatewayAllowed = source?.kind !== "matrix_gateway"
        || input.snapshot.gatewayPolicy?.allowedModelIds.includes(mutation.route.modelId);
      if (!source || !gatewayAllowed || source.providerId !== mutation.route.providerId
        || !source.eligibleModelIds.includes(mutation.route.modelId)
        || (source.kind === "matrix_gateway" ? account !== null : account?.id !== source.accountId)) {
        throw new ProviderSettingsStoreError("invalid_route", 400);
      }
      input.config.harnesses.push({
        id: `harness_${input.id()}`,
        driverId: providerDriverId(mutation.harness, input.canonical),
        harness: mutation.harness,
        displayName: mutation.displayName,
        accentColor: mutation.accentColor ?? null,
        enabled: false,
        selectedAccountId: account?.id ?? null,
        accessSourceId: source.id,
        route: mutation.route,
      });
      return true;
    }
    case "update_harness":
      if (!harness) throw new ProviderSettingsStoreError("not_found", 404);
      if (mutation.displayName !== undefined) harness.displayName = mutation.displayName;
      if (mutation.accentColor !== undefined) harness.accentColor = mutation.accentColor;
      return true;
    case "set_harness_enabled": {
      if (!harness) throw new ProviderSettingsStoreError("not_found", 404);
      const driverId = resolveProviderSettingsDriverId({
        driverId: harness.driverId,
        harness: harness.harness,
        canonical: input.canonical,
      });
      const driver = input.canonical.drivers.find((candidate) => candidate.id === driverId);
      if (mutation.enabled && driver?.installState !== "installed") {
        throw new ProviderSettingsStoreError("invalid_request", 400);
      }
      harness.enabled = mutation.enabled;
      return true;
    }
    case "set_route": {
      if (!harness || harness.route.kind !== "configurable") {
        throw new ProviderSettingsStoreError("invalid_route", 400);
      }
      const source = input.snapshot.accessSources.find((candidate) => candidate.id === mutation.accessSourceId);
      const account = mutation.accountId === null
        ? null
        : input.snapshot.accounts.find((candidate) => candidate.id === mutation.accountId) ?? null;
      const gatewayAllowed = source?.kind !== "matrix_gateway"
        || input.snapshot.gatewayPolicy?.allowedModelIds.includes(mutation.route.modelId);
      if (!source || !gatewayAllowed || source.providerId !== mutation.route.providerId
        || !source.eligibleModelIds.includes(mutation.route.modelId)
        || (source.kind === "matrix_gateway" ? account !== null : account?.id !== source.accountId)) {
        throw new ProviderSettingsStoreError("invalid_route", 400);
      }
      harness.route = mutation.route;
      harness.accessSourceId = source.id;
      harness.selectedAccountId = account?.id ?? null;
      return true;
    }
    case "select_account": {
      if (!harness) throw new ProviderSettingsStoreError("not_found", 404);
      const account = input.snapshot.accounts.find((candidate) => candidate.id === mutation.accountId);
      const source = account
        && input.snapshot.accessSources.find((candidate) => candidate.id === account.accessSourceId);
      if (!account || !source || source.providerId !== harness.route.providerId
        || !source.eligibleModelIds.includes(harness.route.modelId)) {
        throw new ProviderSettingsStoreError("invalid_route", 400);
      }
      harness.selectedAccountId = account.id;
      harness.accessSourceId = account.accessSourceId;
      return true;
    }
    case "select_access_source": {
      if (!harness) throw new ProviderSettingsStoreError("not_found", 404);
      const source = input.snapshot.accessSources.find((candidate) => candidate.id === mutation.accessSourceId);
      const gatewayAllowed = source?.kind !== "matrix_gateway"
        || input.snapshot.gatewayPolicy?.allowedModelIds.includes(harness.route.modelId);
      if (!source || !gatewayAllowed || source.providerId !== harness.route.providerId
        || !source.eligibleModelIds.includes(harness.route.modelId)) {
        throw new ProviderSettingsStoreError("invalid_route", 400);
      }
      harness.accessSourceId = source.id;
      harness.selectedAccountId = source.accountId;
      return true;
    }
    case "set_gateway_budget":
      if (!input.config.gatewayPolicy) throw new ProviderSettingsStoreError("not_found", 404);
      input.config.gatewayPolicy.monthlyBudgetMicrousd = mutation.monthlyBudgetMicrousd;
      return true;
    case "set_gateway_allowlist": {
      const policy = input.config.gatewayPolicy;
      const source = policy
        ? input.snapshot.accessSources.find((candidate) => candidate.id === policy.accessSourceId)
        : undefined;
      if (!policy || !source
        || mutation.allowedModelIds.some((modelId) => !source.eligibleModelIds.includes(modelId))) {
        throw new ProviderSettingsStoreError("invalid_route", 400);
      }
      const activeGatewayModels = input.config.harnesses
        .filter((candidate) => candidate.accessSourceId === policy.accessSourceId)
        .map((candidate) => candidate.route.modelId);
      if (activeGatewayModels.some((modelId) => !mutation.allowedModelIds.includes(modelId))) {
        throw new ProviderSettingsStoreError("invalid_route", 400);
      }
      policy.allowedModelIds = [...mutation.allowedModelIds];
      return true;
    }
    default:
      return false;
  }
}
