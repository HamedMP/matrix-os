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
    const selectable = ready ? eligible : [];
    const available = selectable.length > 0;
    const efforts = [...new Set(selectable.flatMap((model) => model.effortControls))];
    const defaultModel = selectable.find((model) => model.id === instance.defaultModelId)?.id;
    return [{
      id: instance.id,
      driverKind: "kernel" as const,
      displayName: "Matrix AI",
      connectionLabel: "Matrix AI",
      connectionState: available ? "ready" as const : fresh
        && (source.safeReason === "credit_required" || instance.readiness.safeReason === "credit_required")
        ? "credit_required" as const : "unavailable" as const,
      availability: available ? "available" as const : "unavailable" as const,
      workspaceRequirement: "none" as const,
      models: selectable.map((model) => ({
        id: model.id, displayName: model.displayName, availability: "available" as const,
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
      setupActions: [],
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
