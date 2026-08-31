import {
  CanonicalChatModelSelectionSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalChatSkillDescriptorSchema,
  CanonicalProviderCatalogSchema,
  CODEX_VERIFIED_NPM_PACKAGE,
  isRunnableGenericHarnessCredentialRoute,
  type AgentProviderDescriptor,
  type AgentProviderSummary,
  type AgentRuntimeDescriptor,
  type AiProviderSnapshotV3,
  type CanonicalChatAttachmentKind,
  type CanonicalChatModelSelection,
  type CanonicalChatResourceKind,
  type CanonicalChatSafeError,
  type CanonicalModelDescriptor,
  type CanonicalProviderCatalog,
  type CanonicalProviderDriverKind,
  type CanonicalProviderInstanceDescriptor,
  type CanonicalProviderOptionDescriptor,
  type CanonicalChatSkillDescriptor,
  type CanonicalProviderSetupAction,
  type CanonicalProviderSupport,
  type ProviderHarnessInstance,
  type ProviderHarnessKind,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { createHash } from "node:crypto";
import {
  readRuntimeSnapshot,
  type AgentRuntimeSettingsSnapshot,
  type AgentRuntimeSource,
} from "../agent-config/service.js";
import type { CodingAgentProviderRegistry } from "../coding-agents/provider-registry.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";
import { ProviderSettingsStoreError } from "../ai-providers/provider-settings-errors.js";

const ADAPTER_VERSION = "1.0.0";
const SYSTEM_DRIVERS = ["hermes", "openclaw"] as const;
type SystemDriverKind = typeof SYSTEM_DRIVERS[number];
const CODING_DRIVERS = ["codex", "claude_code", "opencode", "pi"] as const;
const MAX_EFFORTS = 4;
const MAX_SKILLS = 64;
// These provider-owned IDs were verified against the live Hermes execution path.
// Omit them from the selector until the provider reports a usable route again.
const LIVE_PROBED_UNAVAILABLE_SYSTEM_MODELS = new Set([
  "opencode-free:deepseek-v4-flash-free",
  "opencode-free:nemotron-3-ultra-free",
]);

const CODING_SETUP: Record<CodingDriverKind, {
  command: string;
  installPackage: string;
  installFlags?: string;
}> = {
  claude_code: {
    command: "claude",
    installPackage: "@anthropic-ai/claude-code@latest",
  },
  codex: {
    command: "codex login --device-auth",
    installPackage: CODEX_VERIFIED_NPM_PACKAGE,
  },
  opencode: {
    command: "opencode",
    installPackage: "opencode-ai@latest",
  },
  pi: {
    command: "pi",
    installPackage: "@earendil-works/pi-coding-agent@latest",
    installFlags: "--ignore-scripts",
  },
};

type InstanceDraft = Omit<CanonicalProviderInstanceDescriptor, "catalogRevision">;
type CodingDriverKind = typeof CODING_DRIVERS[number];

export interface CodingModelCatalogProjection {
  models: Array<Omit<CanonicalModelDescriptor, "availability">>;
  options: CanonicalProviderOptionDescriptor[];
  defaultModel: string;
}

export interface ChatProviderCatalogService {
  getCatalog(principal: RequestPrincipal): Promise<CanonicalProviderCatalog>;
  refresh(principal: RequestPrincipal): Promise<CanonicalProviderCatalog>;
}

export interface HarnessSettingsSnapshotReader {
  getSnapshot(): Promise<ProviderSettingsSnapshot>;
}

export class ProviderCatalogUnavailableError extends Error {
  constructor(readonly retryable: boolean) {
    super("Provider catalog unavailable");
    this.name = "ProviderCatalogUnavailableError";
  }
}

function driverDisplayName(kind: CanonicalProviderDriverKind): string {
  if (kind === "kernel") return "Claude SDK";
  if (kind === "claude_code") return "Claude Code";
  if (kind === "openclaw") return "OpenClaw";
  if (kind === "opencode") return "OpenCode";
  if (kind === "pi") return "Pi";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function codingDriverKind(provider: AgentProviderSummary): CodingDriverKind | null {
  if (provider.kind === "claude" || provider.id === "claude") return "claude_code";
  if (provider.kind === "codex" || provider.id === "codex") return "codex";
  if (provider.kind === "opencode" || provider.id === "opencode") return "opencode";
  if (provider.kind === "pi" || provider.id === "pi") return "pi";
  return null;
}

function canonicalAvailability(
  availability: AgentProviderSummary["availability"],
): CanonicalProviderInstanceDescriptor["availability"] {
  if (availability === "available") return "available";
  if (availability === "setup_required" || availability === "installing") return "setup_required";
  if (availability === "auth_required") return "auth_required";
  return "unavailable";
}

function codingSupports(
  driverKind: CodingDriverKind,
  supportedModes: string[],
): CanonicalProviderSupport {
  const isCodex = driverKind === "codex";
  return {
    rootChat: true,
    resume: true,
    cancellation: true,
    steering: "same_run",
    attachments: driverKind === "pi" || driverKind === "opencode"
      ? ["file", "structured_ref"]
      : ["file", "image", "structured_ref"],
    tools: [],
    approvals: isCodex,
    userInput: isCodex,
    worktrees: "optional",
    resources: ["file", "folder", "project", "task", "app", "terminal_session"],
    interactionModes: supportedModes,
    permissionModes: driverKind === "pi" || driverKind === "opencode"
      ? ["supervised"]
      : ["supervised", "auto_accept_edits", "auto", "full_access"],
  };
}

function codingModels(provider: AgentProviderSummary): CanonicalModelDescriptor[] {
  if (codingDriverKind(provider) === "claude_code") {
    const availability = provider.availability === "available"
      ? "available" as const
      : provider.availability === "auth_required"
        ? "auth_required" as const
        : "unavailable" as const;
    return [
      ["default", "Claude default"],
      ["opus", "Claude Opus"],
      ["sonnet", "Claude Sonnet"],
    ].map(([id, displayName]) => ({
      id: id!,
      displayName: displayName!,
      availability,
      capabilities: ["reasoning", "tools", "vision"],
      supportsVision: true,
      supportsToolUse: true,
    }));
  }
  const parsedModel = provider.defaultModel === undefined
    ? null
    : CanonicalChatModelSelectionSchema.shape.model.safeParse(provider.defaultModel);
  if (parsedModel?.success !== true
    && (codingDriverKind(provider) === "pi" || codingDriverKind(provider) === "opencode")) {
    return [];
  }
  const id = parsedModel?.success === true ? parsedModel.data : "provider-default";
  const availability = provider.availability === "available"
    ? "available" as const
    : provider.availability === "auth_required"
      ? "auth_required" as const
      : "unavailable" as const;
  return [{
    id,
    displayName: parsedModel?.success === true ? parsedModel.data : `${provider.displayName} default`,
    availability,
    capabilities: ["reasoning", "tools"],
    supportsVision: false,
    supportsToolUse: true,
  }];
}

function codingOptions(provider: AgentProviderSummary): CanonicalProviderOptionDescriptor[] {
  const driverKind = codingDriverKind(provider);
  if (driverKind !== "codex" && driverKind !== "claude_code") return [];
  const efforts = driverKind === "claude_code"
    ? ["low", "medium", "high", "max"]
    : ["low", "medium", "high", "xhigh", "max", "ultra"];
  return [{
    id: "effort",
    label: "Reasoning",
    kind: "enum",
    values: efforts.map((value) => ({
      value,
      label: value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1),
    })),
    defaultValue: "low",
    placement: "composer",
  }];
}

function codingInstance(
  provider: AgentProviderSummary,
  skills: CanonicalChatSkillDescriptor[],
  projectedCatalog?: CodingModelCatalogProjection | null,
): InstanceDraft | null {
  const driverKind = codingDriverKind(provider);
  if (driverKind === null) return null;
  const id = `${driverKind}_default`;
  const availability = canonicalAvailability(provider.availability);
  const modelAvailability = provider.availability === "available"
    ? "available" as const
    : provider.availability === "auth_required"
      ? "auth_required" as const
      : "unavailable" as const;
  const models = projectedCatalog?.models.map((model) => ({ ...model, availability: modelAvailability }))
    ?? codingModels(provider);
  const defaultModel = projectedCatalog?.defaultModel;
  const visibleModels = availability === "available" ? models : [];
  const terminalSetupActions = provider.setupActions.filter((action) => (
    action.kind === "foreground_terminal"
  ));
  return {
    id,
    driverKind,
    displayName: provider.displayName,
    availability,
    workspaceRequirement: "project_optional",
    models: visibleModels,
    options: availability === "available"
      ? projectedCatalog?.options ?? codingOptions(provider)
      : [],
    skills,
    commands: [],
    setupActions: terminalSetupActions.length > 0 || availability === "available"
      ? terminalSetupActions
      : missingCodingSetupActions(driverKind),
    supports: codingSupports(driverKind, provider.supportedModes),
    ...(availability === "available" && visibleModels.length > 0 ? {
      defaultSelection: {
        instanceId: id,
        model: visibleModels.some((model) => model.id === defaultModel)
          ? defaultModel!
          : visibleModels[0]!.id,
      },
    } : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function visibleSetupCommand(command: string): string {
  return `sh -lc ${shellQuote([
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
    command,
  ].join("; "))}`;
}

function missingCodingSetupActions(
  driverKind: CodingDriverKind,
): CanonicalProviderSetupAction[] {
  const actionId = driverKind === "claude_code" ? "claude" : driverKind;
  const displayName = driverDisplayName(driverKind);
  const setup = CODING_SETUP[driverKind];
  const flags = setup.installFlags ? `${setup.installFlags} ` : "";
  return [{
    id: `${actionId}_install`,
    kind: "foreground_terminal",
    label: `Install ${displayName}`,
    command: visibleSetupCommand(
      `npm install -g ${flags}--prefix "$MATRIX_NODE_PREFIX" ${setup.installPackage}`,
    ),
  }, {
    id: `${actionId}_connect`,
    kind: "foreground_terminal",
    label: `Connect ${displayName}`,
    command: visibleSetupCommand(setup.command),
  }];
}

function unavailableCodingInstance(
  driverKind: CodingDriverKind,
  skills: CanonicalChatSkillDescriptor[],
  inventoryAvailable: boolean,
): InstanceDraft {
  return {
    id: `${driverKind}_default`,
    driverKind,
    displayName: driverDisplayName(driverKind),
    availability: inventoryAvailable ? "setup_required" : "unavailable",
    workspaceRequirement: "project_optional",
    models: [],
    options: [],
    skills,
    commands: [],
    setupActions: inventoryAvailable ? missingCodingSetupActions(driverKind) : [],
    supports: codingSupports(driverKind, []),
  };
}

function systemSupports(driverKind: CanonicalProviderDriverKind): CanonicalProviderSupport {
  return {
    rootChat: true,
    resume: true,
    cancellation: true,
    steering: driverKind === "hermes" || driverKind === "openclaw" ? "same_run" : "none",
    attachments: ["file", "image", "structured_ref"],
    tools: [],
    approvals: false,
    userInput: false,
    worktrees: "none",
    resources: ["file", "folder", "project", "task", "app", "terminal_session"],
    interactionModes: ["default"],
    permissionModes: ["full_access"],
  };
}

function systemModels(
  runtime: CanonicalProviderDriverKind,
  providers: AgentProviderDescriptor[],
): CanonicalModelDescriptor[] {
  return providers
    .filter((provider) => provider.runtime === runtime
      && provider.authStatus.state === "ready"
      && provider.authStatus.authenticated)
    .flatMap((provider) => provider.models
      .filter((model) => model.available
        && !model.id.endsWith("-pro")
        && !LIVE_PROBED_UNAVAILABLE_SYSTEM_MODELS.has(`${provider.id}:${model.id}`))
      .map((model) => ({
        id: `${provider.id}:${model.id}`,
        displayName: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        availability: "available" as const,
        capabilities: model.capabilities,
        supportsVision: model.capabilities.includes("vision"),
        supportsToolUse: model.capabilities.includes("tools"),
      })))
    .slice(0, 64);
}

function systemOptions(
  runtime: CanonicalProviderDriverKind,
  providers: AgentProviderDescriptor[],
): CanonicalProviderOptionDescriptor[] {
  const efforts: string[] = [];
  for (const provider of providers) {
    if (provider.runtime !== runtime) continue;
    for (const model of provider.models) {
      for (const effort of model.efforts) {
        if (!efforts.includes(effort)) efforts.push(effort);
        if (efforts.length === MAX_EFFORTS) break;
      }
      if (efforts.length === MAX_EFFORTS) break;
    }
    if (efforts.length === MAX_EFFORTS) break;
  }
  return efforts.length === 0 ? [] : [{
    id: "effort",
    label: "Reasoning",
    kind: "enum",
    values: efforts.map((effort) => ({
      value: effort,
      label: effort.charAt(0).toUpperCase() + effort.slice(1),
    })),
    placement: "composer",
  }];
}

function systemInstallAction(
  kind: typeof SYSTEM_DRIVERS[number],
): CanonicalProviderSetupAction {
  const displayName = driverDisplayName(kind);
  return {
    id: `${kind}_install`,
    kind: "foreground_terminal",
    label: `Install ${displayName}`,
    command: visibleSetupCommand(
      `/opt/matrix/bin/matrix-agent-runtime-control install ${kind}`,
    ),
  };
}

function systemRepairAction(
  kind: typeof SYSTEM_DRIVERS[number],
): CanonicalProviderSetupAction {
  const displayName = driverDisplayName(kind);
  return {
    id: `${kind}_repair`,
    kind: "foreground_terminal",
    label: `Repair ${displayName}`,
    // Host control's install operation is idempotent: it reruns the pinned
    // installer when the expected executable is absent, which repairs an
    // interrupted install without exposing a second privileged command.
    command: visibleSetupCommand(
      `/opt/matrix/bin/matrix-agent-runtime-control install ${kind}`,
    ),
  };
}

function systemSetupActions(
  kind: typeof SYSTEM_DRIVERS[number],
  runtime: AgentRuntimeDescriptor | undefined,
): CanonicalProviderSetupAction[] {
  const displayName = driverDisplayName(kind);
  if (runtime?.installState === "missing" || runtime?.installState === "installing") {
    return [systemInstallAction(kind)];
  }
  return [{
    id: `${kind}_connect`,
    kind: "foreground_terminal",
    label: `Connect ${displayName}`,
    command: visibleSetupCommand(kind === "openclaw"
      ? "openclaw models auth login --provider openai --device-code --set-default"
      : kind),
  }];
}

function systemAvailability(
  runtime: AgentRuntimeDescriptor | undefined,
  models: CanonicalModelDescriptor[],
  messagingConfigured: boolean,
): CanonicalProviderInstanceDescriptor["availability"] {
  if (runtime === undefined) return "unavailable";
  if (runtime.installState === "missing" || runtime.installState === "installing") return "setup_required";
  if (runtime.selectionState !== "active") return "unavailable";
  if (!messagingConfigured) return "auth_required";
  if (models.some((model) => model.availability === "available")) return "available";
  if (!runtime.configured || models.some((model) => model.availability === "auth_required")) {
    return "auth_required";
  }
  return "unavailable";
}

function systemInstance(input: {
  kind: typeof SYSTEM_DRIVERS[number];
  runtime?: AgentRuntimeDescriptor;
  providers: AgentProviderDescriptor[];
  selectedProvider: string | null;
  selectedModel: string | null;
  messagingConfigured: boolean;
  skills: CanonicalChatSkillDescriptor[];
}): InstanceDraft {
  const id = `${input.kind}_default`;
  const harnessConfigured = input.messagingConfigured
    && input.selectedProvider !== null
    && input.selectedModel !== null;
  const discoveredModels = systemModels(input.kind, input.providers).map((model) => (
    harnessConfigured || model.availability === "unavailable"
      ? model
      : { ...model, availability: "auth_required" as const }
  ));
  const availability = systemAvailability(input.runtime, discoveredModels, harnessConfigured);
  const models = availability === "available" ? discoveredModels : [];
  const selectedModel = input.selectedProvider && input.selectedModel
    ? `${input.selectedProvider}:${input.selectedModel}`
    : null;
  const hasSelectedModel = selectedModel !== null
    && models.some((model) => model.id === selectedModel && model.availability === "available");
  return {
    id,
    driverKind: input.kind,
    displayName: input.runtime?.displayName ?? driverDisplayName(input.kind),
    availability,
    workspaceRequirement: "none",
    models,
    options: [],
    skills: input.skills,
    commands: [],
    setupActions: systemSetupActions(input.kind, input.runtime),
    supports: systemSupports(input.kind),
    ...(availability === "available" && hasSelectedModel ? {
      defaultSelection: { instanceId: id, model: selectedModel! },
    } : {}),
  };
}

function catalogRevision(drivers: unknown, instances: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ drivers, instances }))
    .digest("hex")
    .slice(0, 24);
  return `catalog_${digest}`;
}

const GENERIC_DRIVERS = ["hermes", "openclaw", "pi", "opencode"] as const;
type GenericDriverKind = typeof GENERIC_DRIVERS[number];

function genericHarnessKind(kind: CanonicalProviderDriverKind): GenericDriverKind | null {
  return GENERIC_DRIVERS.includes(kind as GenericDriverKind) ? kind as GenericDriverKind : null;
}

function settingsHarnessKind(kind: CanonicalProviderDriverKind): ProviderHarnessKind | null {
  if (kind === "pi" || kind === "opencode") return kind;
  return null;
}

function systemHarnessKind(kind: CanonicalProviderDriverKind): ProviderHarnessKind | null {
  if (kind === "hermes" || kind === "openclaw") return kind;
  return null;
}

function unavailableReasonFor(
  instance: InstanceDraft,
): NonNullable<CanonicalProviderInstanceDescriptor["unavailabilityReason"]> {
  if (instance.availability === "setup_required") return "not_installed";
  if (instance.availability === "auth_required") return "authentication_required";
  return "runtime_unavailable";
}

function unavailableInstance(
  instance: InstanceDraft,
  reason: NonNullable<CanonicalProviderInstanceDescriptor["unavailabilityReason"]>,
): InstanceDraft {
  return {
    ...instance,
    availability: "unavailable",
    unavailabilityReason: reason,
    models: [],
    options: [],
    defaultSelection: undefined,
    ...(reason === "runtime_not_runnable" ? { setupActions: [] } : {}),
  };
}

function configuredHarnessInstanceFromAiSnapshot(input: {
  instance: InstanceDraft;
  harness: ProviderHarnessInstance;
  aiSnapshot?: AiProviderSnapshotV3;
  settings: ProviderSettingsSnapshot;
}): InstanceDraft {
  if (input.instance.availability !== "available") {
    return unavailableInstance(input.instance, unavailableReasonFor(input.instance));
  }
  const configured = input.aiSnapshot?.models.find((model) =>
    model.vendor === input.harness.route.providerId && model.id === input.harness.route.modelId
  );
  const projected = input.settings.modelProviders
    .find((provider) => provider.id === input.harness.route.providerId)
    ?.models.find((model) => model.id === input.harness.route.modelId && model.enabled);
  if ((!configured && !projected) || configured?.status === "unavailable" || configured?.status === "retired") {
    return unavailableInstance(input.instance, "runtime_unavailable");
  }
  const modelId = input.harness.route.modelId.startsWith(`${input.harness.route.providerId}:`)
    ? input.harness.route.modelId
    : `${input.harness.route.providerId}:${input.harness.route.modelId}`;
  const capabilities = (configured?.capabilities ?? ["tools"] as const).filter((capability) =>
    capability === "reasoning" || capability === "tools" || capability === "vision"
  );
  const model: CanonicalModelDescriptor = {
    id: modelId,
    displayName: configured?.displayName ?? projected!.displayName,
    availability: "available",
    capabilities,
    supportsVision: capabilities.includes("vision"),
    supportsToolUse: capabilities.includes("tools"),
  };
  return {
    ...input.instance,
    models: [model],
    options: [],
    defaultSelection: { instanceId: input.instance.id, model: modelId },
    unavailabilityReason: undefined,
  };
}

function configuredSystemInstance(
  instance: InstanceDraft,
  harness: ProviderHarnessInstance,
): InstanceDraft {
  if (instance.availability !== "available") {
    return unavailableInstance(instance, unavailableReasonFor(instance));
  }
  const modelId = `${harness.route.providerId}:${harness.route.modelId}`;
  const model = instance.models.find((candidate) =>
    candidate.id === modelId && candidate.availability === "available"
  );
  if (!model) return unavailableInstance(instance, "runtime_unavailable");
  return {
    ...instance,
    models: [model],
    defaultSelection: { instanceId: instance.id, model: model.id },
    unavailabilityReason: undefined,
  };
}

function applyHarnessSettings(input: {
  instances: InstanceDraft[];
  settings: ProviderSettingsSnapshot | null;
  settingsRequired: boolean;
  settingsAvailable: boolean;
  executableDriverKinds?: readonly CanonicalProviderDriverKind[];
  credentialedDriverKinds?: readonly CanonicalProviderDriverKind[];
  aiSnapshot?: AiProviderSnapshotV3;
}): InstanceDraft[] {
  return input.instances.map((instance) => {
    const generic = genericHarnessKind(instance.driverKind);
    const settingsHarness = settingsHarnessKind(instance.driverKind);
    const systemHarness = systemHarnessKind(instance.driverKind);
    if (settingsHarness !== null && input.settingsRequired && (!input.settingsAvailable || input.settings === null)) {
      return unavailableInstance(instance, "settings_unavailable");
    }
    // Runtime inventory is authoritative for whether a harness exists at all.
    // Do not let a disabled preference disguise a missing binary as configured.
    const settingsCanAuthorizeInstalledCodingHarness = (generic === "pi" || generic === "opencode")
      && instance.availability === "auth_required";
    if (settingsHarness !== null && input.settingsRequired
      && (instance.availability === "setup_required" || instance.availability === "auth_required")
      && !settingsCanAuthorizeInstalledCodingHarness) {
      return unavailableInstance(instance, unavailableReasonFor(instance));
    }
    const configuredHarness = settingsHarness ?? systemHarness;
    const enabledHarnesses = configuredHarness !== null && input.settingsAvailable && input.settings !== null
      ? input.settings.harnesses.filter((harness) => harness.harness === configuredHarness && harness.enabled)
      : [];
    const executable = input.executableDriverKinds === undefined
      || input.executableDriverKinds.includes(instance.driverKind);
    const nativeTerminalProfile = (generic === "pi" || generic === "opencode")
      && instance.availability === "available"
      && input.credentialedDriverKinds?.includes(generic);
    if (settingsHarness !== null && input.settingsRequired && enabledHarnesses.length === 0) {
      if (nativeTerminalProfile) {
        return executable
          ? { ...instance, unavailabilityReason: undefined }
          : unavailableInstance(instance, "runtime_not_runnable");
      }
      return unavailableInstance(instance, "disabled_in_settings");
    }
    const enabledHarness = enabledHarnesses[0];
    const configuredInstance = enabledHarness
      ? { ...instance, displayName: enabledHarness.displayName }
      : instance;
    // A selected system runtime has a live provider/model inventory. Keep that
    // inventory authoritative instead of replacing it with a stale settings route.
    if (systemHarness !== null && instance.availability === "available" && executable) {
      return { ...instance, unavailabilityReason: undefined };
    }
    if (enabledHarnesses.length > 1) {
      return unavailableInstance(instance, "multiple_profiles_unsupported");
    }
    if (enabledHarness && systemHarness === null
      && (enabledHarness.authState !== "authenticated" || enabledHarness.accessSourceId === null)) {
      return unavailableInstance(configuredInstance, "authentication_required");
    }
    // System runtime credentials are owned by the native CLI and may only project
    // `unknown` here while the installed binary and exact owner route are known.
    // Explicit negative states remain authoritative and fail closed.
    if (enabledHarness && systemHarness !== null
      && (enabledHarness.authState === "unauthenticated" || enabledHarness.accessSourceId === null)) {
      return unavailableInstance(configuredInstance, "authentication_required");
    }
    if (enabledHarness && systemHarness === null && enabledHarness.connectivity !== "online") {
      return unavailableInstance(configuredInstance, "runtime_unavailable");
    }
    if (enabledHarness && systemHarness !== null && enabledHarness.connectivity === "offline") {
      return unavailableInstance(configuredInstance, "runtime_unavailable");
    }
    if (!executable) {
      const unavailable = unavailableInstance(configuredInstance, "runtime_not_runnable");
      if (instance.driverKind === "hermes" || instance.driverKind === "openclaw") {
        const installAction = instance.setupActions.find((action) => (
          action.id === `${instance.driverKind}_install`
        ));
        return {
          ...unavailable,
          setupActions: [installAction ?? systemRepairAction(instance.driverKind)],
        };
      }
      return unavailable;
    }
    if (instance.availability !== "available"
      && !settingsCanAuthorizeInstalledCodingHarness) {
      return settingsHarness !== null && input.settingsRequired
        ? unavailableInstance(instance, unavailableReasonFor(instance))
        : { ...instance, unavailabilityReason: unavailableReasonFor(instance) };
    }
    if ((generic === "pi" || generic === "opencode")
      && !input.credentialedDriverKinds?.includes(generic)) {
      return unavailableInstance(configuredInstance, "runtime_not_runnable");
    }
    if ((settingsHarness === null && systemHarness === null) || !input.settingsRequired) {
      return instance.availability === "available"
        ? { ...instance, unavailabilityReason: undefined }
        : { ...instance, unavailabilityReason: unavailableReasonFor(instance) };
    }
    if (systemHarness !== null && enabledHarness === undefined) {
      return instance.availability === "available"
        ? { ...instance, unavailabilityReason: undefined }
        : { ...instance, unavailabilityReason: unavailableReasonFor(instance) };
    }
    if (generic === null) {
      return { ...configuredInstance, unavailabilityReason: undefined };
    }
    const harness = enabledHarness!;
    if (generic === "pi" || generic === "opencode") {
      const source = input.settings!.accessSources.find((candidate) => candidate.id === harness.accessSourceId);
      if (!isRunnableGenericHarnessCredentialRoute(harness, source)) {
        return unavailableInstance(configuredInstance, "runtime_not_runnable");
      }
      return configuredHarnessInstanceFromAiSnapshot({
        instance: { ...configuredInstance, availability: "available" },
        harness,
        aiSnapshot: input.aiSnapshot,
        settings: input.settings!,
      });
    }
    if (generic === "hermes" || generic === "openclaw") {
      return configuredSystemInstance(configuredInstance, harness);
    }
    return unavailableInstance(configuredInstance, "runtime_not_runnable");
  });
}

function projectSkills(
  source: Array<{ name: string; description: string }>,
): CanonicalChatSkillDescriptor[] {
  const projected: CanonicalChatSkillDescriptor[] = [];
  const seenIds = new Set<string>();
  let omitted = 0;

  for (const skill of source) {
    if (projected.length >= MAX_SKILLS) break;
    const id = skill.name.trim().toLocaleLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id) || seenIds.has(id)) {
      omitted += 1;
      continue;
    }
    const parsed = CanonicalChatSkillDescriptorSchema.safeParse({
      id,
      displayName: skill.name,
      description: skill.description,
      invocation: `/${id}`,
    });
    if (!parsed.success) {
      omitted += 1;
      continue;
    }
    seenIds.add(id);
    projected.push(parsed.data);
  }

  if (omitted > 0) {
    console.warn(`[chat-providers] Omitted ${omitted} invalid or duplicate Skill catalog entries`);
  }
  return projected;
}

export function createChatProviderCatalogService(options: {
  codingProviders: Pick<CodingAgentProviderRegistry, "listProviders" | "invalidate">;
  agentRuntimeSource: AgentRuntimeSource;
  systemRuntimeSources?: Partial<Record<SystemDriverKind, AgentRuntimeSource>>;
  aiProviderSource?: AiProviderSnapshotReader;
  harnessSettingsSource?: HarnessSettingsSnapshotReader;
  executableDriverKinds?: readonly CanonicalProviderDriverKind[];
  credentialedDriverKinds?: readonly CanonicalProviderDriverKind[];
  runtimeTimeoutMs?: number;
  skillsSource?: () => Array<{ name: string; description: string }>;
  codingModelCatalogSource?: (
    provider: AgentProviderSummary,
    principal: RequestPrincipal,
  ) => Promise<CodingModelCatalogProjection | null>;
}): ChatProviderCatalogService {
  const service: ChatProviderCatalogService = {
    async refresh(principal) {
      options.codingProviders.invalidate(principal.userId);
      options.agentRuntimeSource.invalidate?.();
      for (const source of Object.values(options.systemRuntimeSources ?? {})) {
        source?.invalidate?.();
      }
      if (options.aiProviderSource) {
        try {
          await options.aiProviderSource.getSnapshot({ refresh: true });
        } catch (_error) {
          console.warn("[chat-providers] AI Provider inventory refresh unavailable");
        }
      }
      return service.getCatalog(principal);
    },
    async getCatalog(principal) {
      const systemRuntimeReads = Promise.all(SYSTEM_DRIVERS.map(async (kind) => {
        const source = options.systemRuntimeSources?.[kind];
        if (!source) return [kind, null] as const;
        try {
          return [kind, await readRuntimeSnapshot(source, options.runtimeTimeoutMs)] as const;
        } catch (_error) {
          console.warn(`[chat-providers] ${driverDisplayName(kind)} Provider inventory unavailable`);
          return [kind, null] as const;
        }
      }));
      const [codingResult, runtimeResult, aiProviderResult, settingsResult, systemRuntimeResult] = await Promise.allSettled([
        options.codingProviders.listProviders(principal),
        readRuntimeSnapshot(options.agentRuntimeSource, options.runtimeTimeoutMs),
        options.aiProviderSource?.getSnapshot({ refresh: false }) ?? Promise.resolve(undefined),
        options.harnessSettingsSource?.getSnapshot() ?? Promise.resolve(undefined),
        systemRuntimeReads,
      ]);
      if (codingResult.status === "rejected") {
        console.warn("[chat-providers] Coding Provider inventory unavailable");
      }
      if (runtimeResult.status === "rejected") {
        console.warn("[chat-providers] System Provider inventory unavailable");
      }
      if (aiProviderResult.status === "rejected") {
        console.warn("[chat-providers] AI Provider inventory unavailable");
      }
      if (settingsResult.status === "rejected") {
        console.warn("[chat-providers] Harness settings unavailable");
        if (settingsResult.reason instanceof ProviderSettingsStoreError
          && settingsResult.reason.status === 503) {
          throw new ProviderCatalogUnavailableError(true);
        }
      }

      const coding = codingResult.status === "fulfilled" ? codingResult.value : [];
      const skills = projectSkills(options.skillsSource?.() ?? []);
      const seenCodingDrivers: CanonicalProviderDriverKind[] = [];
      const codingInstances: InstanceDraft[] = [];
      for (const provider of coding) {
        let projectedCatalog: CodingModelCatalogProjection | null = null;
        if (options.codingModelCatalogSource) {
          try {
            projectedCatalog = await options.codingModelCatalogSource(provider, principal);
          } catch (_error) {
            console.warn("[chat-providers] Coding model catalog unavailable");
          }
        }
        const instance = codingInstance(provider, skills, projectedCatalog);
        if (instance === null) continue;
        if (seenCodingDrivers.includes(instance.driverKind)) {
          throw new ProviderCatalogUnavailableError(false);
        }
        seenCodingDrivers.push(instance.driverKind);
        codingInstances.push(instance);
      }

      const snapshot = runtimeResult.status === "fulfilled" ? runtimeResult.value : undefined;
      const systemRuntimeSnapshots = new Map<SystemDriverKind, AgentRuntimeSettingsSnapshot>(
        systemRuntimeResult.status === "fulfilled"
          ? systemRuntimeResult.value.flatMap(([kind, value]) => value === null ? [] : [[kind, value]])
          : [],
      );
      const systemInstances = SYSTEM_DRIVERS.map((kind) => {
        const nativeSnapshot = systemRuntimeSnapshots.get(kind);
        const instanceSnapshot = nativeSnapshot ?? snapshot;
        return systemInstance({
          kind,
          runtime: instanceSnapshot?.runtime.options.find((runtime) => runtime.id === kind),
          providers: instanceSnapshot?.providers ?? [],
          selectedProvider: instanceSnapshot?.messaging.runtime === kind
            ? instanceSnapshot.messaging.provider
            : null,
          selectedModel: instanceSnapshot?.messaging.runtime === kind
            ? instanceSnapshot.messaging.model
            : null,
          messagingConfigured: instanceSnapshot?.messaging.runtime === kind
            && instanceSnapshot.messaging.configured,
          skills,
        });
      });
      const completeCodingInstances = CODING_DRIVERS.map((kind) =>
        codingInstances.find((instance) => instance.driverKind === kind)
          ?? unavailableCodingInstance(kind, skills, codingResult.status === "fulfilled")
      );
      const aiSnapshot = aiProviderResult.status === "fulfilled"
        ? aiProviderResult.value
        : undefined;
      const executableDriverKinds = options.executableDriverKinds;
      const instances = applyHarnessSettings({
        instances: [
        ...systemInstances,
        ...completeCodingInstances,
        ],
        settings: settingsResult.status === "fulfilled" ? settingsResult.value ?? null : null,
        settingsRequired: options.harnessSettingsSource !== undefined,
        settingsAvailable: settingsResult.status === "fulfilled",
        executableDriverKinds,
        credentialedDriverKinds: options.credentialedDriverKinds,
        aiSnapshot,
      });
      const driverKinds: CanonicalProviderDriverKind[] = [
        ...SYSTEM_DRIVERS,
        ...CODING_DRIVERS,
      ];
      const drivers = driverKinds.map((kind) => ({
        kind,
        displayName: driverDisplayName(kind),
        adapterVersion: ADAPTER_VERSION,
        capabilityClass: SYSTEM_DRIVERS.includes(kind as typeof SYSTEM_DRIVERS[number])
          ? "system_agent" as const
          : "coding_agent" as const,
      }));
      const revision = catalogRevision(drivers, instances);
      const parsed = CanonicalProviderCatalogSchema.safeParse({
        revision,
        drivers,
        instances: instances.map((instance) => ({ ...instance, catalogRevision: revision })),
      });
      if (!parsed.success) {
        console.warn("[chat-providers] Canonical Provider projection failed validation");
        throw new ProviderCatalogUnavailableError(false);
      }
      return parsed.data;
    },
  };
  return service;
}

interface ProviderSelectionRequirements {
  attachments?: CanonicalChatAttachmentKind[];
  resources?: CanonicalChatResourceKind[];
  interactionMode?: string;
  permissionMode?: string;
  approvals?: boolean;
  userInput?: boolean;
  worktree?: boolean;
}

type ProviderSelectionValidation =
  | { ok: true; instance: CanonicalProviderInstanceDescriptor; selection: CanonicalChatModelSelection }
  | { ok: false; error: CanonicalChatSafeError };

function selectionError(
  code: CanonicalChatSafeError["code"],
  safeMessage: string,
  recoveryActions?: CanonicalChatSafeError["recoveryActions"],
): ProviderSelectionValidation {
  return {
    ok: false,
    error: CanonicalChatSafeErrorSchema.parse({
      code,
      safeMessage,
      retryable: false,
      ...(recoveryActions ? { recoveryActions } : {}),
    }),
  };
}

function optionsMatch(
  selection: CanonicalChatModelSelection,
  instance: CanonicalProviderInstanceDescriptor,
): boolean {
  return (selection.options ?? []).every((selected) => {
    const option = instance.options.find((candidate) => candidate.id === selected.id);
    if (option === undefined) return false;
    if (option.kind === "boolean") return typeof selected.value === "boolean";
    return typeof selected.value === "string"
      && option.values?.some((candidate) => candidate.value === selected.value) === true;
  });
}

function supportsRequirements(
  supports: CanonicalProviderSupport,
  requirements: ProviderSelectionRequirements,
): boolean {
  return (requirements.attachments ?? []).every((value) => supports.attachments.includes(value))
    && (requirements.resources ?? []).every((value) => supports.resources.includes(value))
    && (!requirements.interactionMode || supports.interactionModes.includes(requirements.interactionMode))
    && (!requirements.permissionMode || supports.permissionModes.includes(requirements.permissionMode))
    && (!requirements.approvals || supports.approvals)
    && (!requirements.userInput || supports.userInput)
    && (!requirements.worktree || supports.worktrees !== "none");
}

export function validateChatProviderSelection(input: {
  catalog: CanonicalProviderCatalog;
  selection: CanonicalChatModelSelection;
  boundInstanceId?: string;
  requirements?: ProviderSelectionRequirements;
}): ProviderSelectionValidation {
  const selection = CanonicalChatModelSelectionSchema.safeParse(input.selection);
  if (!selection.success) {
    return selectionError("capability_mismatch", "The selected Provider options are not supported.");
  }
  if (input.boundInstanceId !== undefined
    && input.boundInstanceId !== selection.data.instanceId) {
    return selectionError(
      "provider_instance_locked",
      "This Chat is already bound to another Provider instance.",
      ["fork_chat", "start_new_chat"],
    );
  }
  const instance = input.catalog.instances.find((candidate) =>
    candidate.id === selection.data.instanceId
  );
  if (instance?.availability !== "available") {
    return selectionError(
      "provider_unavailable",
      "The selected Provider is not available.",
      ["select_provider", "open_setup_terminal"],
    );
  }
  const model = instance.models.find((candidate) => candidate.id === selection.data.model);
  if (model?.availability !== "available") {
    return selectionError("model_unavailable", "The selected model is not available.", ["select_provider"]);
  }
  if (!optionsMatch(selection.data, instance)
    || !supportsRequirements(instance.supports, input.requirements ?? {})) {
    return selectionError("capability_mismatch", "The selected Provider does not support this request.");
  }
  return { ok: true, instance, selection: selection.data };
}
