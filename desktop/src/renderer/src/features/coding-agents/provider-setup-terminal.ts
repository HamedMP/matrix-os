import type { AgentProviderSummary, SafeSetupAction } from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";
import type { useTabs } from "../../stores/tabs";

const MAX_PROVIDER_SETUP_ACTIONS = 10;
const SESSION_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;

type ForegroundSetupAction = Extract<SafeSetupAction, { kind: "foreground_terminal" }>;

export type ProviderSetupCommand = {
  key: string;
  label: string;
  command: string;
  sessionName: string;
};

function safeSessionSegment(value: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return segment || "agent";
}

function setupSessionHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(-6);
}

function setupSessionName(providerId: string, actionId: string): string {
  const prefix = "matrix-setup-";
  const rawSegment = providerId === actionId ? providerId : `${providerId}-${actionId}`;
  const suffix = setupSessionHash(`${providerId}:${actionId}`);
  const maxSegmentLength = 31 - prefix.length - suffix.length - 1;
  const segment = safeSessionSegment(rawSegment).slice(0, maxSegmentLength).replace(/-$/g, "");
  return `${prefix}${segment || "agent"}-${suffix}`;
}

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
        sessionName: setupSessionName(provider.id, foregroundAction.id),
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
    const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", {
      name: setup.sessionName,
      cwd: "projects",
      cmd: setup.command,
    });
    const sessionName = typeof response.name === "string" && SESSION_NAME_PATTERN.test(response.name)
      ? response.name
      : setup.sessionName;
    openTab({ kind: "terminal", sessionName, title: setup.label });
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
