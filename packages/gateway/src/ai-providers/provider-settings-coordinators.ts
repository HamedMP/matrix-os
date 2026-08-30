import type {
  AiProviderSnapshotV3,
  ProviderConnectionAttempt,
  ProviderDependencyCounts,
  ProviderHarnessKind,
  ProviderSettingsMutation,
} from "@matrix-os/contracts";
import type { ProviderConfigurationMutation } from "./provider-settings-mutations.js";
import type { ProviderSettingsDependencyReader } from "./provider-settings-projector.js";

export interface CanonicalProviderSnapshotReader {
  getSnapshot(options?: { refresh?: boolean }): Promise<AiProviderSnapshotV3>;
}

export interface ProviderAccountDependencyCoordinator extends ProviderSettingsDependencyReader {
  reassignDependencies(input: {
    fromAccountId: string;
    target: Extract<ProviderSettingsMutation, { type: "reassign_account" }>["target"];
    scope: Extract<ProviderSettingsMutation, { type: "reassign_account" }>["scope"];
    dependencyGuard: ProviderDependencyCounts;
    harnessInstanceIds: string[];
    idempotencyKey: string;
  }): Promise<void>;
}

/** Implementations must durably deduplicate by idempotencyKey. */
export interface ProviderAccountLifecycleCoordinator {
  logout(input: { accountId: string; idempotencyKey: string }): Promise<void>;
  remove(input: { accountId: string; idempotencyKey: string }): Promise<void>;
}

/** Applies settings to the real runtime/control plane and durably deduplicates the key. */
export interface ProviderSettingsRuntimeCoordinator {
  applyConfiguration(input: {
    mutation: ProviderConfigurationMutation;
    idempotencyKey: string;
  }): Promise<void>;
}

/** Creates/adopts the actual auth surface and durably deduplicates by mutation key. */
export interface ProviderLoginCoordinator {
  startLogin(input: {
    mutation: Extract<ProviderSettingsMutation, { type: "start_login" }>;
    harness: {
      id: string;
      harness: ProviderHarnessKind;
      providerId: string;
      modelId: string;
    };
  }): Promise<ProviderConnectionAttempt>;
}
