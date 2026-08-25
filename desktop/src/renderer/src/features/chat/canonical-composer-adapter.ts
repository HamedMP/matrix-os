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

export function createLegacyGlobalProviderCatalog({
  hasProject,
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
        defaultSelection: { instanceId: "hermes_default", model: "provider-default" },
      },
      {
        id: "codex_default",
        driverKind: "codex",
        displayName: "Codex",
        availability: hasProject ? "available" : "unavailable",
        workspaceRequirement: "project_required",
        catalogRevision: revision,
        models: [{
          id: "provider-default",
          displayName: "Provider default",
          availability: hasProject ? "available" : "unavailable",
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
        ...(hasProject ? { defaultSelection: { instanceId: "codex_default", model: "provider-default" } } : {}),
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
    drivers: instances
      .filter((instance, index, all) => (
        all.findIndex((candidate) => candidate.driverKind === instance.driverKind) === index
      ))
      .map((instance) => ({
        kind: instance.driverKind,
        displayName: instance.driverKind === "claude_code" ? "Claude Code" : instance.displayName,
        adapterVersion: "1.0.0",
        capabilityClass: "coding_agent" as const,
      })),
    instances,
  });
}

export function filterCatalogForLegacyProject(
  catalog: CanonicalProviderCatalog,
  summary: RuntimeSummary,
): CanonicalProviderCatalog {
  const legacyIds = createLegacyProjectProviderCatalog(summary).instances.map((instance) => instance.id);
  const instances = catalog.instances.filter((instance) => legacyIds.includes(instance.id));
  const kinds = instances.map((instance) => instance.driverKind);
  return {
    ...catalog,
    drivers: catalog.drivers.filter((driver) => kinds.includes(driver.kind)),
    instances,
  };
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
  if (!provider) return current;
  const mode = provider.supportedModes.find((candidate) => candidate === selection.interactionMode)
    ?? provider.defaultMode;
  return {
    ...current,
    providerId: provider.id,
    mode,
    ...permissionDraft(selection.permissionMode),
  };
}
