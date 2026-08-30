import type {
  AiProviderSnapshotV3,
  ProviderHarnessInstallState,
  ProviderHarnessKind,
  ProviderLoginMethod,
  ProviderSettingsMutation,
  ProviderSettingsSupportedAction,
} from "@matrix-os/contracts";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import type {
  ProviderAccountDependencyCoordinator,
  ProviderAccountLifecycleCoordinator,
  ProviderLifecycleAccount,
  ProviderLoginCoordinator,
  ProviderSettingsRuntimeCoordinator,
} from "./provider-settings-coordinators.js";
import { resolveProviderSettingsDriverId } from "./provider-settings-driver-id.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

type CliLifecycleDriver =
  | { driverId: "claude_code"; harness: "claude" }
  | { driverId: "codex"; harness: "codex" };

function lifecycleDriver(input: {
  driverId: string;
  providerId: string;
  authMethod: ProviderLoginMethod;
}): CliLifecycleDriver | null {
  if ((input.driverId === "kernel" || input.driverId === "claude_code")
    && input.providerId === "anthropic" && input.authMethod === "terminal") {
    return { driverId: "claude_code", harness: "claude" };
  }
  if (input.driverId === "codex" && input.providerId === "openai"
    && (input.authMethod === "terminal" || input.authMethod === "oauth")) {
    return { driverId: "codex", harness: "codex" };
  }
  return null;
}

export function coordinatorLifecycleAccounts(input: {
  config: ProviderSettingsConfiguration;
  canonical: AiProviderSnapshotV3;
}): ProviderLifecycleAccount[] {
  const preliminary = input.config.accountProfiles.flatMap((profile): ProviderLifecycleAccount[] => {
    const canonicalAccount = input.canonical.accounts.find((account) => account.id === profile.id);
    const candidates: Partial<Record<"codex" | "claude_code", CliLifecycleDriver>> = {};
    for (const harness of input.config.harnesses) {
      if (harness.selectedAccountId !== profile.id && harness.accessSourceId !== profile.accessSourceId) continue;
      const candidate = lifecycleDriver({
        driverId: harness.driverId,
        providerId: profile.providerId,
        authMethod: profile.authMethod,
      });
      if (candidate) candidates[candidate.driverId] = candidate;
    }
    for (const instance of input.canonical.instances) {
      if (instance.accountId !== profile.id || instance.accessSourceId !== profile.accessSourceId) continue;
      const candidate = lifecycleDriver({
        driverId: instance.driverId,
        providerId: profile.providerId,
        authMethod: profile.authMethod,
      });
      if (candidate) candidates[candidate.driverId] = candidate;
    }
    const values = Object.values(candidates);
    if (values.length !== 1) return [];
    const candidate = values[0]!;
    const driver = input.canonical.drivers.find((item) => item.id === candidate.driverId);
    return [{
      id: profile.id,
      providerId: profile.providerId,
      authMethod: profile.authMethod,
      accessSourceId: profile.accessSourceId,
      ...candidate,
      installState: driver?.installState ?? "missing",
      authenticated: canonicalAccount?.state === "ready" && canonicalAccount.authMethod !== null,
      driverAccountCount: 0,
    }];
  });
  const counts = { codex: 0, claude_code: 0 };
  for (const account of preliminary) {
    if (account.driverId === "codex") counts.codex += 1;
    else counts.claude_code += 1;
  }
  return preliminary.map((account) => ({
    ...account,
    driverAccountCount: account.driverId === "codex" ? counts.codex : counts.claude_code,
  }));
}

export function coordinatorLifecycleAccount(input: {
  accountId: string;
  config: ProviderSettingsConfiguration;
  canonical: AiProviderSnapshotV3;
}): ProviderLifecycleAccount | undefined {
  return coordinatorLifecycleAccounts(input).find((account) => account.id === input.accountId);
}

export function requireCoordinatorLifecycleAccount(
  lifecycle: ProviderAccountLifecycleCoordinator | undefined,
  accountId: string,
  config: ProviderSettingsConfiguration,
  canonical: AiProviderSnapshotV3,
): ProviderLifecycleAccount {
  const account = coordinatorLifecycleAccount({ accountId, config, canonical });
  if (!lifecycle || !account) {
    throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
  }
  return account;
}

export function assertProviderSettingsAction(input: {
  type: ProviderSettingsMutation["type"];
  supportedActions: readonly ProviderSettingsSupportedAction[];
  hasDependencies: boolean;
  hasLifecycle: boolean;
}): void {
  if (input.supportedActions.includes(input.type)) return;
  if (input.type === "remove_account") {
    if (!input.hasDependencies) throw new ProviderSettingsStoreError("dependency_unavailable", 503);
    if (input.hasLifecycle) return;
  }
  if (input.type === "reassign_account") {
    throw new ProviderSettingsStoreError("dependency_unavailable", 503);
  }
  if (input.type === "logout_account" && input.hasLifecycle) return;
  if (input.type === "start_login" || input.type === "logout_account" || input.type === "remove_account") {
    throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
  }
  throw new ProviderSettingsStoreError("runtime_unavailable", 503);
}

export function coordinatorLoginHarness(input: {
  harness: ProviderSettingsConfiguration["harnesses"][number];
  canonical: AiProviderSnapshotV3;
}): {
  id: string;
  driverId: string;
  harness: ProviderHarnessKind;
  installState: ProviderHarnessInstallState;
} {
  const driverId = resolveProviderSettingsDriverId({
    driverId: input.harness.driverId,
    harness: input.harness.harness,
    canonical: input.canonical,
  });
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
  const lifecycleAccounts = input.lifecycle
    ? coordinatorLifecycleAccounts({ config: input.config, canonical: input.canonical })
    : [];
  if (input.lifecycle && lifecycleAccounts.some((account) =>
    input.lifecycle!.supportedActions(account).includes("logout_account"))) {
    actions.push("logout_account");
  }
  if (input.lifecycle && input.dependencies && lifecycleAccounts.some((account) =>
    input.lifecycle!.supportedActions(account).includes("remove_account"))) {
    actions.push("remove_account");
  }
  if (input.dependencies) actions.push("reassign_account");
  return actions;
}
