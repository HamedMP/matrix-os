import { resolveManagedPiRoute, MANAGED_PI_INSTANCE_ID, BotRouteError } from "../bots/route-resolver.js";
import type {
  AiProviderSnapshotV3,
  CanonicalChatSkillDescriptor,
  CanonicalProviderInstanceDescriptor,
} from "@matrix-os/contracts";
import { MATRIX_PI_OPENROUTER_INSTANCE_ID } from "@matrix-os/contracts";

/** Project funded readiness from V3; model discovery must never acquire a credential. */
export function managedChatInstances(
  snapshot: AiProviderSnapshotV3 | undefined,
  skills: CanonicalChatSkillDescriptor[],
  now = Date.now(),
): Array<Omit<CanonicalProviderInstanceDescriptor, "catalogRevision">> {
  if (!snapshot) return [];
  return snapshot.instances.flatMap((instance) => {
    const source = snapshot.accessSources.find((entry) => entry.id === instance.accessSourceId);
    const matrixIncluded = instance.driverId === "kernel" && instance.id === "kernel_matrix_included"
      && source?.id === "matrix_included" && source.fundingKind === "matrix_included";
    const ownerOpenRouter = instance.driverId === "kernel" && instance.id === "kernel_owner_openrouter"
      && source?.id === "owner_openrouter" && source.fundingKind === "owner_api_key"
      && source.credentialGeneration !== undefined;
    if (!matrixIncluded && !ownerOpenRouter) return [];
    const fresh = (source.staleAfter === null || Date.parse(source.staleAfter) > now)
      && (instance.readiness.staleAfter === null || Date.parse(instance.readiness.staleAfter) > now);
    const ready = fresh && source.state === "ready" && instance.readiness.state === "ready";
    const candidates = snapshot.models.filter((model) => instance.modelIds.includes(model.id)
      && source.eligibleModelIds.includes(model.id)
      && model.eligibleAccessSourceIds.includes(source.id)
      && model.status !== "retired");
    const eligible = candidates.filter((model) => model.status !== "unavailable");
    const policyObserved = fresh && source.checkedAt !== null && Date.parse(source.checkedAt) <= now
      && source.staleAfter !== null;
    const selectable = ready ? eligible : [];
    const discoverable = ownerOpenRouter ? candidates : policyObserved ? eligible : selectable;
    const available = selectable.length > 0;
    const efforts = [...new Set(selectable.flatMap((model) => model.effortControls))];
    const defaultModel = selectable.find((model) => model.id === instance.defaultModelId)?.id;
    const kernelInstance: Omit<CanonicalProviderInstanceDescriptor, "catalogRevision"> = {
      id: instance.id,
      driverKind: "kernel" as const,
      displayName: ownerOpenRouter ? "Claude SDK · OpenRouter" : "Matrix AI",
      connectionLabel: ownerOpenRouter ? "Billed by OpenRouter" : "Matrix AI",
      connectionState: available ? "ready" as const : fresh
        && (source.safeReason === "budget_exceeded" || instance.readiness.safeReason === "budget_exceeded")
        ? "budget_exceeded" as const : fresh
        && (source.safeReason === "credit_reserved" || instance.readiness.safeReason === "credit_reserved")
        ? "credit_reserved" as const : fresh
          && (source.safeReason === "credit_required" || instance.readiness.safeReason === "credit_required")
          ? "credit_required" as const : "unavailable" as const,
      availability: available ? "available" as const : "unavailable" as const,
      workspaceRequirement: "none" as const,
      models: discoverable.map((model) => ({
        id: model.id, displayName: model.displayName,
        availability: available && model.status !== "unavailable" ? "available" as const : "unavailable" as const,
        capabilities: model.capabilities,
        supportsVision: model.capabilities.includes("vision"),
        supportsToolUse: model.capabilities.includes("tools"),
      })),
      options: ownerOpenRouter ? [{
        id: "credentialGeneration", label: "Credential", kind: "enum" as const, placement: "advanced" as const,
        values: [{ value: source.credentialGeneration!, label: "Current connection" }],
        defaultValue: source.credentialGeneration!,
      }] : efforts.length === 0 ? [] : [{
        id: "effort", label: "Reasoning", kind: "enum" as const, placement: "composer" as const,
        values: efforts.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })),
      }],
      skills,
      commands: [],
      setupActions: available ? [] : [{ id: "matrix_ai_settings", kind: "open_settings" as const, label: "Agents & providers" }],
      supports: {
        rootChat: true, resume: true, cancellation: true, steering: "none" as const,
        attachments: ["file", "image", "structured_ref"], tools: [], approvals: false,
        userInput: false, worktrees: "none" as const,
        resources: ["file", "folder", "project", "task", "app", "terminal_session"],
        interactionModes: ["default"], permissionModes: ["full_access"],
      },
      ...(available && defaultModel ? { defaultSelection: {
        instanceId: instance.id, model: defaultModel,
        ...(ownerOpenRouter ? { options: [{ id: "credentialGeneration", value: source.credentialGeneration! }] } : {}),
      } } : {}),
    };
    return [kernelInstance];
  });
}

/** Both managed Pi sources use the same Chat permission and workspace policy. */
export const MANAGED_PI_CHAT_SUPPORTS: CanonicalProviderInstanceDescriptor["supports"] = {
  rootChat: true, resume: false, cancellation: true, steering: "same_run", attachments: ["file", "image"], tools: [],
  approvals: true, userInput: false, worktrees: "optional", resources: [], interactionModes: ["default"],
  permissionModes: ["supervised", "full_access"],
};

/** The owned Pi worker has its own identity; old kernel checkpoints remain unchanged. */
export function managedPiChatInstances(snapshot: AiProviderSnapshotV3 | undefined, now = Date.now()): Array<Omit<CanonicalProviderInstanceDescriptor, "catalogRevision">> {
  if (!snapshot) return [];
  const eligible = snapshot.models.filter((model) => {
    if (!model.capabilities.includes("tools")) return false;
    try { resolveManagedPiRoute(snapshot, { instanceId: MANAGED_PI_INSTANCE_ID, model: model.id }, now); return true; }
    catch (error: unknown) { if (error instanceof BotRouteError) return false; throw error; }
  });
  const available = eligible.length > 0;
  const sources = snapshot.accessSources.filter(source => ["matrix_included", "matrix_cloudflare"].includes(source.id)
    && source.fundingKind === "matrix_included"
    && source.checkedAt !== null && Date.parse(source.checkedAt) <= now
    && source.staleAfter !== null && Date.parse(source.staleAfter) > now);
  const discoverable = snapshot.models.filter(model => model.capabilities.includes("tools")
    && model.status !== "unavailable" && model.status !== "retired"
    && sources.some(source => (source.discoverableModelIds ?? source.eligibleModelIds).includes(model.id)
      && model.eligibleAccessSourceIds.includes(source.id) && source.vendor === model.vendor));
  const unavailableModels = discoverable.filter(model => !eligible.some(ready => ready.id === model.id));
  const fundingSources = sources.filter(source => unavailableModels.some(model => (source.discoverableModelIds ?? source.eligibleModelIds).includes(model.id)
    && model.eligibleAccessSourceIds.includes(source.id)));
  const fundingState = fundingSources.some(source => source.safeReason === "budget_exceeded") ? "budget_exceeded" as const
    : fundingSources.some(source => source.safeReason === "credit_reserved") ? "credit_reserved" as const
    : fundingSources.some(source => source.safeReason === "credit_required") ? "credit_required" as const : "unavailable" as const;
  const managed: Omit<CanonicalProviderInstanceDescriptor, "catalogRevision"> = {
    id: MANAGED_PI_INSTANCE_ID, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    availability: available ? "available" : "unavailable", connectionState: available ? "ready" : fundingState,
    workspaceRequirement: "project_optional",
    // Keep catalog order stable as health receipts change. Only the exact
    // existing route resolver can make a discovery row executable.
    models: snapshot.models.filter(model => eligible.includes(model) || discoverable.includes(model)).map(model => ({
      id: model.id, displayName: model.displayName, availability: eligible.includes(model) ? "available" as const : "unavailable" as const,
      capabilities: model.capabilities, supportsVision: model.capabilities.includes("vision"), supportsToolUse: true })),
    options: [], skills: [], commands: [],
    setupActions: available ? [] : [{ id: "matrix_ai_settings", kind: "open_settings" as const, label: "Agents & providers" }],
    supports: MANAGED_PI_CHAT_SUPPORTS,
    ...(available ? { defaultSelection: { instanceId: MANAGED_PI_INSTANCE_ID, model: eligible[0]!.id } } : {}),
  };
  const openRouterSource = snapshot.accessSources.find(source => source.id === "owner_openrouter");
  const openRouterInstance = snapshot.instances.find(instance => instance.id === MATRIX_PI_OPENROUTER_INSTANCE_ID
    && instance.driverId === "matrix_pi" && instance.accessSourceId === "owner_openrouter");
  if (!openRouterSource || !openRouterInstance || !openRouterSource.credentialGeneration) return [managed];
  const openRouterModels = snapshot.models.filter(model => openRouterInstance.modelIds.includes(model.id)
    && openRouterSource.eligibleModelIds.includes(model.id) && model.eligibleAccessSourceIds.includes(openRouterSource.id)
    && model.status !== "retired");
  const openRouterReady = openRouterSource.state === "ready" && openRouterInstance.readiness.state === "ready"
    && openRouterModels.some(model => model.status !== "unavailable");
  const selectionOptions = [{ id: "credentialGeneration", value: openRouterSource.credentialGeneration }];
  const openRouter: Omit<CanonicalProviderInstanceDescriptor, "catalogRevision"> = {
    id: MATRIX_PI_OPENROUTER_INSTANCE_ID, driverKind: "matrix_pi", displayName: "Matrix AI · OpenRouter",
    connectionLabel: "Billed by OpenRouter", availability: openRouterReady ? "available" : "unavailable",
    connectionState: openRouterReady ? "ready" : "unavailable", workspaceRequirement: "project_optional",
    models: openRouterModels.map(model => ({ id: model.id, displayName: model.displayName,
      availability: openRouterReady && model.status !== "unavailable" ? "available" as const : "unavailable" as const,
      capabilities: model.capabilities, supportsVision: model.capabilities.includes("vision"), supportsToolUse: model.capabilities.includes("tools") })),
    options: [{ id: "credentialGeneration", label: "Credential", kind: "enum", placement: "advanced",
      values: [{ value: openRouterSource.credentialGeneration, label: "Current connection" }], defaultValue: openRouterSource.credentialGeneration }],
    skills: [], commands: [], supports: MANAGED_PI_CHAT_SUPPORTS,
    setupActions: [{ id: "openrouter_settings", kind: "open_settings", label: "Agents & providers" }],
    ...(openRouterReady && openRouterInstance.defaultModelId ? { defaultSelection: {
      instanceId: MATRIX_PI_OPENROUTER_INSTANCE_ID, model: openRouterInstance.defaultModelId, options: selectionOptions,
    } } : {}),
  };
  return [managed, openRouter];
}
