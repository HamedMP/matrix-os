import type { AiProviderSnapshotV3, CanonicalModelDescriptor, CanonicalProviderInstanceDescriptor, ProviderAccessSource, ProviderHarnessInstance, ProviderSettingsSnapshot } from "@matrix-os/contracts";

type InstanceDraft = Omit<CanonicalProviderInstanceDescriptor, "catalogRevision">;

export function unavailableReasonFor(
  instance: InstanceDraft,
): NonNullable<CanonicalProviderInstanceDescriptor["unavailabilityReason"]> {
  if (instance.availability === "setup_required") return "not_installed";
  if (instance.availability === "auth_required") return "authentication_required";
  return "runtime_unavailable";
}

export function unavailableInstance(
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

export function configuredHarnessInstanceFromAiSnapshot(input: {
  instance: InstanceDraft;
  harness: Pick<ProviderHarnessInstance, "route" | "accessSourceId">;
  aiSnapshot?: AiProviderSnapshotV3;
  settings: Pick<ProviderSettingsSnapshot, "modelProviders"> & {
    accessSources: Array<Pick<ProviderAccessSource, "id" | "kind">>;
  };
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
  const source = input.settings.accessSources.find((candidate) => candidate.id === input.harness.accessSourceId);
  return {
    ...input.instance,
    // Only the selected source determines this label. Never expose credential/profile details.
    connectionLabel: source ? source.kind === "matrix_gateway" ? "Matrix AI" : "Own account" : undefined,
    models: [model],
    options: [],
    defaultSelection: { instanceId: input.instance.id, model: modelId },
    unavailabilityReason: undefined,
  };
}
