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
const MAX_SETUP_SESSION_NAME_LENGTH = 31;
const SETUP_RUN_SUFFIX_LENGTH = 6;
const SESSION_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;
let setupRunSequence = 0;

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

function freshSetupSessionName(setup: ProviderSetupCommand): string {
  setupRunSequence = (setupRunSequence + 1) % Number.MAX_SAFE_INTEGER;
  const randomIdentity = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : "";
  const suffix = setupSessionHash(
    `${setup.key}:${setup.command}:${Date.now()}:${setupRunSequence}:${randomIdentity}`,
  );
  const stableName = /-[a-z0-9]{6}$/.test(setup.sessionName)
    ? setup.sessionName.slice(0, -(SETUP_RUN_SUFFIX_LENGTH + 1))
    : setup.sessionName;
  const maxBaseLength = MAX_SETUP_SESSION_NAME_LENGTH - SETUP_RUN_SUFFIX_LENGTH - 1;
  const base = stableName.slice(0, maxBaseLength).replace(/-+$/g, "") || "matrix-setup";
  return `${base}-${suffix}`;
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
    const runtimeGeneration = captureRuntimeGeneration();
    const requestedSessionName = freshSetupSessionName(setup);
    const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", {
      name: requestedSessionName,
      cwd: "projects",
      cmd: setup.command,
    });
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return true;
    const sessionName = typeof response.name === "string" && SESSION_NAME_PATTERN.test(response.name)
      ? response.name
      : requestedSessionName;
    useShellSessions.getState().adoptCreatedSession(sessionName);
    openTab({ kind: "terminals", title: "Terminal" });
    useTabs.getState().requestTerminalSession(sessionName);
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

  if (!providerSupportsSetupAction(input.provider, foregroundAction)) return false;
  const setup = {
    key: `${input.provider.id}:${foregroundAction.id}`,
    label: foregroundAction.label,
    command: foregroundAction.command,
    sessionName: setupSessionName(input.provider.id, foregroundAction.id),
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
    sessionName: setupSessionName(input.instance.id, input.action.id),
  }, input.openTab, "provider-catalog-setup");
}
