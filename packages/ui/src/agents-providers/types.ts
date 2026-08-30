import type {
  ProviderAccentColor,
  ProviderConfigurableRoute,
  ProviderDependencyCounts,
  ProviderHarnessKind,
  ProviderHarnessRoute,
  ProviderLoginMethod,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";

export type ProviderSettingsMutationIntent =
  | {
      type: "add_harness";
      harness: ProviderHarnessKind;
      displayName: string;
      accentColor?: ProviderAccentColor | null;
      route: ProviderHarnessRoute;
      accessSourceId: string;
      accountId: string | null;
    }
  | { type: "update_harness"; harnessInstanceId: string; displayName?: string; accentColor?: ProviderAccentColor | null }
  | { type: "set_harness_enabled"; harnessInstanceId: string; enabled: boolean }
  | {
      type: "set_route";
      harnessInstanceId: string;
      route: ProviderConfigurableRoute;
      accessSourceId: string;
      accountId: string | null;
    }
  | { type: "select_account"; harnessInstanceId: string; accountId: string }
  | { type: "select_access_source"; harnessInstanceId: string; accessSourceId: string }
  | { type: "start_login"; harnessInstanceId: string; accountId: string | null; method: ProviderLoginMethod }
  | { type: "logout_account"; accountId: string }
  | {
      type: "remove_account";
      accountId: string;
      dependencyGuard: ProviderDependencyCounts;
      confirmation: "remove_account";
    }
  | {
      type: "reassign_account";
      fromAccountId: string;
      target: { kind: "account"; accountId: string } | { kind: "access_source"; accessSourceId: string };
      scope: "all_dependencies";
      dependencyGuard: ProviderDependencyCounts;
    }
  | { type: "set_gateway_budget"; monthlyBudgetMicrousd: number | null }
  | { type: "set_gateway_allowlist"; allowedModelIds: string[] };

export interface AgentsProvidersViewProps {
  snapshot: ProviderSettingsSnapshot;
  selectedHarnessId: string | null;
  connectionAttempt?: import("@matrix-os/contracts").ProviderConnectionAttempt | null;
  busy?: boolean;
  error?: string | null;
  onSelectHarness: (harnessInstanceId: string) => void;
  onRefresh: () => void;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
  onOpenTerminal: (terminalSessionId: string) => void;
  onOpenBrowser: (authorizationPath: string) => void;
  onAddCredit: (accessSourceId: string) => void;
}
