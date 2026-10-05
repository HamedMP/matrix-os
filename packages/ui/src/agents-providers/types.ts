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
  | { type: "remove_harness"; harnessInstanceId: string; confirmation: "remove_harness" }
  | { type: "update_harness"; harnessInstanceId: string; displayName?: string; accentColor?: ProviderAccentColor | null }
  | { type: "set_harness_enabled"; harnessInstanceId: string; enabled: boolean }
  | {
      type: "set_route";
      harnessInstanceId: string;
      enableHarness?: boolean;
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
  onRefreshForConnection?: () => Promise<ProviderSettingsSnapshot | null>;
  onMutate: (intent: ProviderSettingsMutationIntent) => Promise<boolean> | void;
  workflowClient?: ProviderWorkflowClient;
  onOpenAuthorizationUrl?: (url: string) => void;
  onLoadUsageHistory?: (cursor: string | null, signal: AbortSignal) => Promise<import("@matrix-os/contracts").AiCreditHistoryResponse>;
  onSetupHarness?: (harness: ProviderHarnessKind) => Promise<boolean>;
  onOpenTerminal: (terminalSessionId: string) => void;
  onOpenBrowser: (authorizationPath: string) => void;
  onAddCredit: (
    accessSourceId: string,
    packageId: "usd_5" | "usd_10" | "usd_25",
    requestId: string,
  ) => Promise<void> | void;
}

/** Optional V2 fields preserve the historical client capability contract. */
export type ProviderWorkflowUICapability = import("@matrix-os/contracts").ProviderWorkflowCapability & {
  connectionOptions?: import("@matrix-os/contracts").ProviderWorkflowConnectionOption[];
};
export type ProviderWorkflowUIOperation = import("@matrix-os/contracts").ProviderWorkflow & {
  connectionOption?: import("@matrix-os/contracts").ProviderWorkflowConnectionOption | null;
};

/** Separate capability-negotiated transport; secrets never enter mutation receipts. */
export interface ProviderWorkflowClient {
  botConnections?: import("../chat-agents/bots/provider-connections-client.js").BotConnectionClient;
  capabilities(signal: AbortSignal): Promise<ProviderWorkflowUICapability[]>;
  start(request: import("@matrix-os/contracts").ProviderWorkflowStart, signal: AbortSignal): Promise<ProviderWorkflowUIOperation>;
  startConnection?(request: import("@matrix-os/contracts").ProviderWorkflowStartV2, signal: AbortSignal): Promise<ProviderWorkflowUIOperation>;
  submitConnectionKey?(request: import("@matrix-os/contracts").ProviderWorkflowKeyV2, signal: AbortSignal): Promise<{ verified: true }>;
  get(id: string, signal: AbortSignal): Promise<ProviderWorkflowUIOperation>;
  cancel(id: string, signal: AbortSignal): Promise<ProviderWorkflowUIOperation>;
  submitCode?(id: string, code: string, signal: AbortSignal): Promise<{ accepted: true }>;
  submitKey(request: import("@matrix-os/contracts").ProviderWorkflowKey, signal: AbortSignal): Promise<{ verified: true }>;
  logs(harnessInstanceId: string, signal: AbortSignal): Promise<{ entries: { at: string; event: "started" | "running" | "succeeded" | "failed" | "cancelled" | "expired" }[] }>;
}
