import type { AiProviderSnapshotV3, FundedAiEffectivePolicy, ProviderSettingsSnapshot } from "@matrix-os/contracts";

/** Only caller-validated platform policy can offer models. Health remains separate. */
export function projectMatrixModelInventory(
  canonical: AiProviderSnapshotV3,
  policy: FundedAiEffectivePolicy | undefined,
): NonNullable<ProviderSettingsSnapshot["matrixModelInventory"]> {
  if (!policy?.enabled) return [];
  const allowed = new Set(policy.allowedModelIds);
  return canonical.accessSources.flatMap(source => {
    if (source.fundingKind !== "matrix_included" && source.fundingKind !== "matrix_addon") return [];
    return canonical.models.filter(model => model.vendor === source.vendor
      && model.status !== "retired" && model.status !== "unavailable"
      && model.eligibleAccessSourceIds.includes(source.id)
      && (allowed.has(model.id) || allowed.has(`${model.vendor}/${model.id}`)))
      .map(model => ({ id: model.id, providerId: source.vendor, accessSourceId: source.id,
        displayName: model.displayName, enabled: true, capabilities: [...model.capabilities] }));
  }).slice(0, 256);
}
