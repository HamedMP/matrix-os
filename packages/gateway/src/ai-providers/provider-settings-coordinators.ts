import type {
  AiProviderSnapshotV3,
  ProviderConnectionAttempt,
  ProviderDependencyCounts,
  ProviderHarnessInstallState,
  ProviderHarnessKind,
  ProviderLoginMethod,
  ProviderSettingsMutation,
  ProviderSettingsSupportedAction,
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

export interface ProviderLifecycleAccount {
  id: string;
  providerId: string;
  authMethod: ProviderLoginMethod;
  accessSourceId: string;
  driverId: string;
  harness: ProviderHarnessKind;
  installState: ProviderHarnessInstallState;
  authenticated: boolean;
  /** CLI drivers currently own one active account; multiple rows are ambiguous. */
  driverAccountCount: number;
}

/** Implementations must guard the exact account/driver and durably deduplicate by key. */
export interface ProviderAccountLifecycleCoordinator {
  supportedActions(account: ProviderLifecycleAccount): readonly Extract<
    ProviderSettingsSupportedAction,
    "logout_account" | "remove_account"
  >[];
  logout(input: { account: ProviderLifecycleAccount; idempotencyKey: string }): Promise<void>;
  remove(input: { account: ProviderLifecycleAccount; idempotencyKey: string }): Promise<void>;
}

/** Applies settings to the real runtime/control plane and durably deduplicates the key. */
export interface ProviderSettingsRuntimeCoordinator {
  readonly supportedActions: readonly ProviderConfigurationMutation["type"][];
  applyConfiguration(input: {
    mutation: ProviderConfigurationMutation;
    idempotencyKey: string;
  }): Promise<void>;
}

/** Creates/adopts the actual auth surface and durably deduplicates by mutation key. */
export interface ProviderLoginCoordinator {
  supportedMethods(harness: {
    id: string;
    driverId: string;
    harness: ProviderHarnessKind;
    installState: ProviderHarnessInstallState;
  }): readonly ProviderLoginMethod[];
  startLogin(input: {
    mutation: Extract<ProviderSettingsMutation, { type: "start_login" }>;
    harness: {
      id: string;
      driverId: string;
      harness: ProviderHarnessKind;
      providerId: string;
      modelId: string;
      installState: ProviderHarnessInstallState;
    };
  }): Promise<ProviderConnectionAttempt>;
}
