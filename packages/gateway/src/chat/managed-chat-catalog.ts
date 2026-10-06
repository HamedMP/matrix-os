import { resolveManagedPiRoute, MANAGED_PI_INSTANCE_ID, BotRouteError } from "../bots/route-resolver.js";
import type {
  AiProviderSnapshotV3,
  CanonicalChatSkillDescriptor,
  CanonicalProviderInstanceDescriptor,
} from "@matrix-os/contracts";

/** Project funded readiness from V3; model discovery must never acquire a credential. */
export function managedChatInstances(
  snapshot: AiProviderSnapshotV3 | undefined,
  skills: CanonicalChatSkillDescriptor[],
  now = Date.now(),
): Array<Omit<CanonicalProviderInstanceDescriptor, "catalogRevision">> {
  if (!snapshot) return [];
  return snapshot.instances.flatMap((instance) => {
    const source = snapshot.accessSources.find((entry) => entry.id === instance.accessSourceId);
    if (instance.driverId !== "kernel" || instance.id !== "kernel_matrix_included"
      || source?.id !== "matrix_included" || source.fundingKind !== "matrix_included") return [];
    const fresh = (source.staleAfter === null || Date.parse(source.staleAfter) > now)
      && (instance.readiness.staleAfter === null || Date.parse(instance.readiness.staleAfter) > now);
    const ready = fresh && source.state === "ready" && instance.readiness.state === "ready";
    const eligible = snapshot.models.filter((model) => instance.modelIds.includes(model.id)
      && source.eligibleModelIds.includes(model.id)
      && model.eligibleAccessSourceIds.includes(source.id)
      && model.status !== "unavailable" && model.status !== "retired");
    const policyObserved = fresh && source.checkedAt !== null && Date.parse(source.checkedAt) <= now
      && source.staleAfter !== null;
    const selectable = ready ? eligible : [];
    const discoverable = policyObserved ? eligible : selectable;
    const available = selectable.length > 0;
    const efforts = [...new Set(selectable.flatMap((model) => model.effortControls))];
    const defaultModel = selectable.find((model) => model.id === instance.defaultModelId)?.id;
    return [{
      id: instance.id,
      driverKind: "kernel" as const,
      displayName: "Matrix AI",
      connectionLabel: "Matrix AI",
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
        id: model.id, displayName: model.displayName, availability: available ? "available" as const : "unavailable" as const,
        capabilities: model.capabilities,
        supportsVision: model.capabilities.includes("vision"),
        supportsToolUse: model.capabilities.includes("tools"),
      })),
      options: efforts.length === 0 ? [] : [{
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
      ...(defaultModel ? { defaultSelection: { instanceId: instance.id, model: defaultModel } } : {}),
    }];
  });
}

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
    && sources.some(source => source.eligibleModelIds.includes(model.id)
      && model.eligibleAccessSourceIds.includes(source.id) && source.vendor === model.vendor));
  const unavailableModels = discoverable.filter(model => !eligible.some(ready => ready.id === model.id));
  const fundingSources = sources.filter(source => unavailableModels.some(model => source.eligibleModelIds.includes(model.id)
    && model.eligibleAccessSourceIds.includes(source.id)));
  const fundingState = fundingSources.some(source => source.safeReason === "budget_exceeded") ? "budget_exceeded" as const
    : fundingSources.some(source => source.safeReason === "credit_reserved") ? "credit_reserved" as const
    : fundingSources.some(source => source.safeReason === "credit_required") ? "credit_required" as const : "unavailable" as const;
  return [{
    id: MANAGED_PI_INSTANCE_ID, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    availability: available ? "available" : "unavailable", connectionState: available ? "ready" : fundingState,
    workspaceRequirement: "project_optional",
    models: [...eligible.map((model) => ({ id: model.id, displayName: model.displayName, availability: "available" as const,
      capabilities: ["tools" as const], supportsVision: false, supportsToolUse: true })), ...unavailableModels.map(model => ({
        id: model.id, displayName: model.displayName, availability: "unavailable" as const,
        capabilities: ["tools" as const], supportsVision: false, supportsToolUse: true }))],
    options: [], skills: [], commands: [],
    setupActions: available ? [] : [{ id: "matrix_ai_settings", kind: "open_settings" as const, label: "Agents & providers" }],
    supports: { rootChat: true, resume: false, cancellation: true, steering: "same_run", attachments: [], tools: [],
      approvals: true, userInput: false, worktrees: "optional", resources: [], interactionModes: ["default"],
      permissionModes: ["supervised", "full_access"] },
    ...(available ? { defaultSelection: { instanceId: MANAGED_PI_INSTANCE_ID, model: eligible[0]!.id } } : {}),
  }];
}
