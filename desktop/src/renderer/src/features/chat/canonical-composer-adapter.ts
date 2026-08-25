import {
  CanonicalProviderCatalogSchema,
  type AgentProviderSummary,
  type AgentThreadComposerDraft,
  type CanonicalProviderCatalog,
  type CanonicalProviderDriverKind,
  type CanonicalProviderInstanceDescriptor,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import type { CanonicalComposerSelection } from "./canonical-composer-state";

const SHARED_LEGACY_CATALOG_DRIVERS: CanonicalProviderCatalog["drivers"] = [
  { kind: "hermes", displayName: "Hermes", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
  { kind: "openclaw", displayName: "OpenClaw", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
  { kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
  { kind: "claude_code", displayName: "Claude Code", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
  { kind: "opencode", displayName: "OpenCode", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
  { kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
];

export function createLegacyGlobalProviderCatalog({
  hasProject: _hasProject,
}: {
  hasProject: boolean;
}): CanonicalProviderCatalog {
  const revision = "legacy_global";
  const sharedResources = ["file", "folder", "project", "task", "app", "terminal_session"] as const;
  return CanonicalProviderCatalogSchema.parse({
    revision,
    drivers: [
      { kind: "hermes", displayName: "Hermes", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
      { kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
    ],
    instances: [
      {
        id: "hermes_default",
        driverKind: "hermes",
        displayName: "Hermes",
        availability: "available",
        workspaceRequirement: "none",
        catalogRevision: revision,
        models: [{
          id: "provider-default",
          displayName: "Current model",
          availability: "available",
          capabilities: ["reasoning", "tools"],
          supportsVision: false,
          supportsToolUse: true,
        }],
        options: [{
          id: "effort",
          label: "Reasoning",
          kind: "enum",
          values: ["low", "medium", "high"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })),
          defaultValue: "low",
          placement: "composer",
        }],
        skills: [],
        commands: [],
        setupActions: [],
        defaultSelection: { instanceId: "hermes_default", model: "provider-default" },
        supports: {
          rootChat: true,
          resume: true,
          cancellation: true,
          attachments: ["file", "image", "structured_ref"],
          tools: [],
          approvals: false,
          userInput: false,
          worktrees: "none",
          resources: sharedResources,
          interactionModes: ["default"],
          permissionModes: ["supervised", "auto_accept_edits", "auto", "full_access"],
        },
      },
      {
        id: "codex_default",
        driverKind: "codex",
        displayName: "Codex",
        availability: "unavailable",
        workspaceRequirement: "project_required",
        catalogRevision: revision,
        models: [{
          id: "provider-default",
          displayName: "Provider default",
          availability: "unavailable",
          capabilities: ["reasoning", "tools"],
          supportsVision: false,
          supportsToolUse: true,
        }],
        options: [],
        skills: [],
        commands: [],
        setupActions: [],
        supports: {
          rootChat: true,
          resume: true,
          cancellation: true,
          attachments: ["file", "image", "structured_ref"],
          tools: [],
          approvals: true,
          userInput: true,
          worktrees: "optional",
          resources: sharedResources,
          interactionModes: ["default", "plan"],
          permissionModes: ["supervised", "auto_accept_edits", "auto", "full_access"],
        },
      },
    ],
  });
}

function driverKindForLegacyProvider(
  provider: AgentProviderSummary,
): CanonicalProviderDriverKind | null {
  if (provider.kind === "claude") return "claude_code";
  if (provider.kind === "codex") return "codex";
  if (provider.kind === "opencode") return "opencode";
  if (provider.kind === "pi") return "pi";
  return null;
}

function providerForDriver(
  summary: RuntimeSummary,
  driverKind: CanonicalProviderDriverKind,
): AgentProviderSummary | undefined {
  return summary.providers.find((provider) => driverKindForLegacyProvider(provider) === driverKind);
}

function legacyProviderIdForDriver(
  driverKind: CanonicalProviderDriverKind,
): string | null {
  if (driverKind === "claude_code") return "claude";
  if (driverKind === "codex" || driverKind === "opencode" || driverKind === "pi") {
    return driverKind;
  }
  return null;
}

function availabilityForLegacyProvider(
  provider: AgentProviderSummary,
): CanonicalProviderInstanceDescriptor["availability"] {
  if (
    provider.availability === "available"
    && provider.installStatus === "installed"
    && provider.authStatus === "authenticated"
  ) return "available";
  if (provider.installStatus === "missing" || provider.installStatus === "installing"
    || provider.availability === "setup_required" || provider.availability === "installing") {
    return "setup_required";
  }
  if (provider.authStatus === "missing" || provider.authStatus === "expired"
    || provider.availability === "auth_required") return "auth_required";
  return "unavailable";
}

function legacyInstance(
  provider: AgentProviderSummary,
  revision: string,
): CanonicalProviderInstanceDescriptor | null {
  const driverKind = driverKindForLegacyProvider(provider);
  if (!driverKind) return null;
  const id = `${driverKind}_default`;
  const modelId = provider.defaultModel ?? "provider-default";
  const availability = availabilityForLegacyProvider(provider);
  const modelAvailability = availability === "available"
    ? "available" as const
    : availability === "auth_required"
      ? "auth_required" as const
      : "unavailable" as const;
  return {
    id,
    driverKind,
    displayName: provider.displayName,
    availability,
    workspaceRequirement: "project_optional",
    catalogRevision: revision,
    models: [{
      id: modelId,
      displayName: provider.defaultModel ?? "Provider default",
      availability: modelAvailability,
      capabilities: ["reasoning", "tools"],
      supportsVision: false,
      supportsToolUse: true,
    }],
    options: driverKind === "codex" ? [{
      id: "effort",
      label: "Reasoning",
      kind: "enum",
      values: ["low", "medium", "high", "xhigh", "max", "ultra"].map((value) => ({
        value,
        label: value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1),
      })),
      defaultValue: "low",
      placement: "composer",
    }] : [],
    skills: [],
    commands: [],
    setupActions: provider.setupActions,
    supports: {
      rootChat: true,
      resume: true,
      cancellation: true,
      attachments: driverKind === "pi" ? ["structured_ref"] : ["file", "image", "structured_ref"],
      tools: [],
      approvals: driverKind === "codex",
      userInput: driverKind === "codex",
      worktrees: "optional",
      resources: ["file", "folder", "project", "task", "app", "terminal_session"],
      interactionModes: [
        provider.defaultMode,
        ...provider.supportedModes.filter((mode) => mode !== provider.defaultMode),
      ],
      permissionModes: ["supervised", "auto_accept_edits", "auto", "full_access"],
    },
    ...(availability === "available"
      ? { defaultSelection: { instanceId: id, model: modelId } }
      : {}),
  };
}

export function createLegacyProjectProviderCatalog(
  summary: RuntimeSummary,
): CanonicalProviderCatalog {
  const revision = `legacy_${summary.runtime.id}`;
  const instances = summary.providers.flatMap((provider) => {
    const instance = legacyInstance(provider, revision);
    return instance ? [instance] : [];
  });
  return CanonicalProviderCatalogSchema.parse({
    revision,
    // The fallback must preserve the same product catalog shape as the
    // canonical Gateway endpoint. Missing adapters have no Instance and are
    // therefore visible-but-unavailable in the picker instead of disappearing.
    drivers: SHARED_LEGACY_CATALOG_DRIVERS,
    instances,
  });
}

function unavailableInstance(
  instance: CanonicalProviderInstanceDescriptor,
): CanonicalProviderInstanceDescriptor {
  const { defaultSelection: _defaultSelection, ...descriptor } = instance;
  return {
    ...descriptor,
    availability: "unavailable",
    models: instance.models.map((model) => ({ ...model, availability: "unavailable" })),
  };
}

/**
 * The pre-canonical Global Chat websocket always dispatches through Hermes and
 * carries neither an Instance/model selection nor provider-specific options.
 * Keep the complete catalog inspectable, but make only the current Hermes
 * model executable so the selector never promises a route the request omits.
 */
export function filterCatalogForLegacyGlobal(
  catalog: CanonicalProviderCatalog,
): CanonicalProviderCatalog {
  const instances = catalog.instances.map((instance) => {
    if (instance.driverKind !== "hermes") return unavailableInstance(instance);
    const currentModelId = instance.defaultSelection?.model
      ?? instance.models.find((model) => model.availability === "available")?.id;
    return {
      ...instance,
      models: instance.models.map((model) => ({
        ...model,
        availability: instance.availability === "available" && model.id === currentModelId
          ? "available" as const
          : "unavailable" as const,
      })),
      ...(instance.availability === "available" && currentModelId
        ? { defaultSelection: { instanceId: instance.id, model: currentModelId } }
        : {}),
    };
  });
  return CanonicalProviderCatalogSchema.parse({ ...catalog, instances });
}

export function filterCatalogForLegacyProject(
  catalog: CanonicalProviderCatalog,
  summary: RuntimeSummary,
): CanonicalProviderCatalog {
  const executableDriverKinds = new Set(
    createLegacyProjectProviderCatalog(summary).instances.map((instance) => instance.driverKind),
  );
  // The selector is a shared product catalog, so Project Chat must not erase
  // General agents or coding harnesses that its legacy create-thread route
  // cannot execute. Keep them visible and fail closed until the canonical
  // Turn/Run path owns execution; otherwise selecting Hermes can silently
  // leave the legacy coding provider in the draft and run the wrong harness.
  const instances = catalog.instances.map((instance) => {
    const driver = catalog.drivers.find((candidate) => candidate.kind === instance.driverKind);
    if (executableDriverKinds.has(instance.driverKind)) {
      const provider = providerForDriver(summary, instance.driverKind);
      const defaultModelId = provider?.defaultModel
        ?? instance.defaultSelection?.model
        ?? instance.models.find((model) => model.availability === "available")?.id;
      const defaultModel = instance.models.find((model) => model.id === defaultModelId)
        ?? instance.models[0];
      if (!defaultModel) return unavailableInstance(instance);
      return {
        ...instance,
        models: [{ ...defaultModel, id: defaultModelId ?? defaultModel.id, displayName: "Provider default" }],
        defaultSelection: {
          instanceId: instance.id,
          model: defaultModelId ?? defaultModel.id,
        },
      };
    }
    if (driver?.capabilityClass === "coding_agent") return instance;
    return unavailableInstance(instance);
  });
  return {
    ...catalog,
    drivers: SHARED_LEGACY_CATALOG_DRIVERS.map((fallbackDriver) => (
      catalog.drivers.find((driver) => driver.kind === fallbackDriver.kind) ?? fallbackDriver
    )),
    instances,
  };
}

function optionValuesAreDefaults(
  instance: CanonicalProviderInstanceDescriptor,
  selection: CanonicalComposerSelection,
): boolean {
  return instance.options.every((option) => {
    const selected = selection.options.find((candidate) => candidate.id === option.id)?.value;
    return selected === undefined || selected === option.defaultValue;
  });
}

export function legacyGlobalSelectionExecutable(
  catalog: CanonicalProviderCatalog,
  selection: CanonicalComposerSelection | null,
): boolean {
  if (!selection) return false;
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
  const model = instance?.models.find((candidate) => candidate.id === selection.model);
  return instance?.driverKind === "hermes"
    && instance.availability === "available"
    && model?.availability === "available"
    && selection.interactionMode === "default"
    && selection.permissionMode === "supervised"
    && optionValuesAreDefaults(instance, selection);
}

export function legacyProjectSelectionExecutable(
  catalog: CanonicalProviderCatalog,
  summary: RuntimeSummary,
  selection: CanonicalComposerSelection | null,
): boolean {
  if (!selection) return false;
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
  const model = instance?.models.find((candidate) => candidate.id === selection.model);
  return Boolean(
    instance
    && providerForDriver(summary, instance.driverKind)
    && instance.availability === "available"
    && model?.availability === "available"
    && optionValuesAreDefaults(instance, selection),
  );
}

export function instanceIdForLegacyProvider(
  catalog: CanonicalProviderCatalog,
  summary: RuntimeSummary,
  providerId: string | undefined,
): string | undefined {
  const provider = summary.providers.find((candidate) => candidate.id === providerId);
  const driverKind = provider ? driverKindForLegacyProvider(provider) : null;
  return driverKind
    ? catalog.instances.find((instance) => instance.driverKind === driverKind)?.id
    : undefined;
}

function permissionDraft(permissionMode: string): Pick<
  AgentThreadComposerDraft,
  "approvalPolicy" | "sandboxMode"
> {
  if (permissionMode === "full_access") {
    return { approvalPolicy: "never", sandboxMode: "full_access" };
  }
  if (permissionMode === "auto") {
    return { approvalPolicy: "on_failure", sandboxMode: "workspace_write" };
  }
  return { approvalPolicy: "on_request", sandboxMode: "workspace_write" };
}

function legacyAgentMode(
  mode: string | undefined,
): AgentThreadComposerDraft["mode"] {
  switch (mode) {
    case "default":
    case "plan":
    case "review":
    case "full_access":
      return mode;
    default:
      return undefined;
  }
}

export function permissionModeForAgentDraft(
  draft: AgentThreadComposerDraft,
): "supervised" | "auto" | "full_access" {
  if (draft.sandboxMode === "full_access" && draft.approvalPolicy === "never") {
    return "full_access";
  }
  if (draft.sandboxMode === "workspace_write" && draft.approvalPolicy === "on_failure") {
    return "auto";
  }
  return "supervised";
}

export function applyCanonicalSelectionToAgentDraft(
  summary: RuntimeSummary,
  catalog: CanonicalProviderCatalog,
  current: AgentThreadComposerDraft,
  selection: CanonicalComposerSelection,
): AgentThreadComposerDraft {
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
  const provider = instance ? providerForDriver(summary, instance.driverKind) : undefined;
  if (!instance) return current;
  const providerId = provider?.id ?? legacyProviderIdForDriver(instance.driverKind);
  if (!providerId) return current;
  const selectedMode = provider
    ? provider.supportedModes.find((candidate) => candidate === selection.interactionMode)
      ?? provider.defaultMode
    : selection.interactionMode;
  const mode = legacyAgentMode(selectedMode) ?? current.mode;
  return {
    ...current,
    providerId,
    mode,
    ...permissionDraft(selection.permissionMode),
  };
}
