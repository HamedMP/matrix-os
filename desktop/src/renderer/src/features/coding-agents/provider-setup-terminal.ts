import type { AgentProviderSummary, SafeSetupAction } from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";
import type { useTabs } from "../../stores/tabs";

const MAX_PROVIDER_SETUP_ACTIONS = 10;

type ForegroundSetupAction = Extract<SafeSetupAction, { kind: "foreground_terminal" }>;

export type ProviderSetupCommand = {
  key: string;
  label: string;
  command: string;
};

export function providerSetupCommands(providers: AgentProviderSummary[]): ProviderSetupCommand[] {
  const commands: ProviderSetupCommand[] = [];
  for (const provider of providers) {
    for (const action of provider.setupActions) {
      if (action.kind !== "foreground_terminal") continue;
      const foregroundAction: ForegroundSetupAction = action;
      commands.push({
        key: `${provider.id}:${foregroundAction.id}`,
        label: foregroundAction.label,
        command: foregroundAction.command,
      });
    }
  }
  return commands.slice(0, MAX_PROVIDER_SETUP_ACTIONS);
}

export async function openProviderSetupTerminal(
  api: ApiClient,
  setup: ProviderSetupCommand,
  openTab: ReturnType<typeof useTabs.getState>["openTab"],
  logPrefix = "provider-setup",
): Promise<boolean> {
  try {
    const ensured = await api.post<{ workspace?: { id?: unknown } }>("/api/terminal/workspaces/ensure", {});
    const workspaceId = typeof ensured.workspace?.id === "string" ? ensured.workspace.id : "";
    if (!/^tws_[0-9a-f]{32}$/.test(workspaceId)) return false;
    const response = await api.post<{ tab?: { id?: unknown } }>(`/api/terminal/workspaces/${workspaceId}/tabs`, {
      name: setup.label,
      cwd: "projects",
      command: ["sh", "-lc", setup.command],
    });
    const tabId = typeof response.tab?.id === "string" ? response.tab.id : "";
    if (!/^tt_[0-9a-f]{32}$/.test(tabId)) return false;
    openTab({ kind: "terminal", sessionName: `${workspaceId}:${tabId}`, title: setup.label });
    return true;
  } catch (err: unknown) {
    console.error(`[${logPrefix}] Failed to open provider setup terminal:`, err instanceof Error ? err.name : typeof err);
    return false;
  }
}

export async function executeProviderSetupAction(input: {
  provider: AgentProviderSummary;
  action: SafeSetupAction;
  api: ApiClient | null;
  openTab: ReturnType<typeof useTabs.getState>["openTab"];
  requestSettingsSection: (section: string) => void;
}): Promise<boolean> {
  if (input.action.kind === "open_settings") {
    input.requestSettingsSection("providers");
    input.openTab({ kind: "settings", title: "Settings" });
    return true;
  }
  if (!input.api) return false;
  const foregroundAction = input.action;

  const trustedAction = input.provider.setupActions.find((candidate) =>
    candidate.kind === "foreground_terminal" &&
    candidate.id === foregroundAction.id &&
    candidate.label === foregroundAction.label &&
    candidate.command === foregroundAction.command
  );
  if (!trustedAction || trustedAction.kind !== "foreground_terminal") return false;
  const setup = providerSetupCommands([input.provider]).find((candidate) =>
    candidate.key === `${input.provider.id}:${trustedAction.id}` &&
    candidate.label === trustedAction.label &&
    candidate.command === trustedAction.command
  );
  if (!setup) return false;
  return await openProviderSetupTerminal(input.api, setup, input.openTab, "provider-readiness");
}
