import type {
  AgentProviderSummary,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
  SafeSetupAction,
} from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";
import { useTabs } from "../../stores/tabs";
import { useShellSessions } from "../../stores/shell-sessions";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { providerSupportsSetupAction } from "./provider-readiness";

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
  const runtimeGeneration = captureRuntimeGeneration();
  try {
    const ensured = await api.post<{ workspace?: { id?: unknown } }>("/api/terminal/workspaces/ensure", {});
    const workspaceId = typeof ensured.workspace?.id === "string" ? ensured.workspace.id : "";
    if (!/^tws_[0-9a-f]{32}$/.test(workspaceId)) return false;
    const response = await api.post<{ tab?: { id?: unknown } }>(`/api/terminal/workspaces/${workspaceId}/tabs`, {
      name: setup.label,
      cwd: "projects",
      command: ["sh", "-lc", setup.command],
    });
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return true;
    const tabId = typeof response.tab?.id === "string" ? response.tab.id : "";
    if (!/^tt_[0-9a-f]{32}$/.test(tabId)) return false;
    const sessionName = `${workspaceId}:${tabId}`;
    useShellSessions.getState().adoptCreatedSession(sessionName);
    openTab({ kind: "terminals", title: "Terminal" });
    useTabs.getState().requestTerminalSession(sessionName);
    return true;
  } catch (err: unknown) {
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return true;
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

  if (!providerSupportsSetupAction(input.provider, foregroundAction)) return false;
  const setup = {
    key: `${input.provider.id}:${foregroundAction.id}`,
    label: foregroundAction.label,
    command: foregroundAction.command,
  };
  return await openProviderSetupTerminal(input.api, setup, input.openTab, "provider-readiness");
}

function catalogActionPrefix(instance: CanonicalProviderInstanceDescriptor): string {
  return instance.driverKind === "claude_code" ? "claude" : instance.driverKind;
}

function sameCatalogAction(
  left: CanonicalProviderSetupAction,
  right: CanonicalProviderSetupAction,
): boolean {
  if (left.id !== right.id || left.kind !== right.kind || left.label !== right.label) return false;
  return left.kind === "open_settings"
    || (right.kind === "foreground_terminal" && left.command === right.command);
}

export async function executeCatalogProviderSetupAction(input: {
  instance: CanonicalProviderInstanceDescriptor;
  action: CanonicalProviderSetupAction;
  api: ApiClient | null;
  openTab: ReturnType<typeof useTabs.getState>["openTab"];
}): Promise<boolean> {
  if (input.action.kind !== "foreground_terminal" || !input.api) return false;
  const prefix = catalogActionPrefix(input.instance);
  if (!input.action.id.startsWith(`${prefix}_`)) return false;
  if (!input.instance.setupActions.some((candidate) => sameCatalogAction(candidate, input.action))) {
    return false;
  }
  return await openProviderSetupTerminal(input.api, {
    key: `${input.instance.id}:${input.action.id}`,
    label: input.action.label,
    command: input.action.command,
  }, input.openTab, "provider-catalog-setup");
}
