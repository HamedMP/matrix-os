import type {
  AiProviderSnapshotV3,
  ProviderHarnessInstallState,
  ProviderHarnessKind,
  ProviderLoginMethod,
  ProviderSettingsSupportedAction,
} from "@matrix-os/contracts";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import type {
  ProviderAccountDependencyCoordinator,
  ProviderAccountLifecycleCoordinator,
  ProviderLoginCoordinator,
  ProviderSettingsRuntimeCoordinator,
} from "./provider-settings-coordinators.js";

export function coordinatorLoginHarness(input: {
  harness: ProviderSettingsConfiguration["harnesses"][number];
  canonical: AiProviderSnapshotV3;
}): {
  id: string;
  driverId: string;
  harness: ProviderHarnessKind;
  installState: ProviderHarnessInstallState;
} {
  const driverId = input.harness.driverId === "kernel" && input.harness.harness === "claude"
    ? "claude_code"
    : input.harness.driverId;
  const driver = input.canonical.drivers.find((candidate) => candidate.id === driverId);
  return {
    id: input.harness.id,
    driverId,
    harness: input.harness.harness,
    installState: driver?.installState ?? "missing",
  };
}

export function coordinatorLoginMethods(input: {
  login?: ProviderLoginCoordinator;
  harness: ProviderSettingsConfiguration["harnesses"][number];
  canonical: AiProviderSnapshotV3;
}): readonly ProviderLoginMethod[] {
  if (!input.login) return [];
  return input.login.supportedMethods(coordinatorLoginHarness(input));
}

export function supportedProviderSettingsActions(input: {
  runtime?: ProviderSettingsRuntimeCoordinator;
  login?: ProviderLoginCoordinator;
  lifecycle?: ProviderAccountLifecycleCoordinator;
  dependencies?: ProviderAccountDependencyCoordinator;
  config: ProviderSettingsConfiguration;
  canonical: AiProviderSnapshotV3;
}): ProviderSettingsSupportedAction[] {
  const actions: ProviderSettingsSupportedAction[] = input.runtime
    ? input.runtime.supportedActions.filter((action) =>
        input.config.gatewayPolicy !== null
        || (action !== "set_gateway_budget" && action !== "set_gateway_allowlist"))
    : [];
  if (input.login && input.config.harnesses.some((harness) => coordinatorLoginMethods({
      login: input.login,
      harness,
      canonical: input.canonical,
    }).length > 0)) {
    actions.push("start_login");
  }
  if (input.lifecycle) actions.push("logout_account");
  if (input.lifecycle && input.dependencies) actions.push("remove_account");
  if (input.dependencies) actions.push("reassign_account");
  return actions;
}
