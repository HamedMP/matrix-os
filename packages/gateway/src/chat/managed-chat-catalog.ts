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
      || source?.id !== "matrix_included" || source.fundingKind !== "matrix_included"
      || source.state !== "ready" || instance.readiness.state !== "ready"
      || (source.staleAfter !== null && Date.parse(source.staleAfter) <= now)
      || (instance.readiness.staleAfter !== null && Date.parse(instance.readiness.staleAfter) <= now)) return [];
    const eligible = snapshot.models.filter((model) => instance.modelIds.includes(model.id)
      && source.eligibleModelIds.includes(model.id)
      && model.eligibleAccessSourceIds.includes(source.id)
      && model.status !== "unavailable" && model.status !== "retired");
    if (eligible.length === 0) return [];
    const efforts = [...new Set(eligible.flatMap((model) => model.effortControls))];
    const defaultModel = eligible.find((model) => model.id === instance.defaultModelId)?.id;
    return [{
      id: instance.id,
      driverKind: "kernel" as const,
      displayName: "Matrix AI",
      availability: "available" as const,
      workspaceRequirement: "none" as const,
      models: eligible.map((model) => ({
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
