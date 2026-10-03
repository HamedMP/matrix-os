import { canonicalProviderAvailabilityReasonLabel, canonicalProviderFundingState, isLegacyMatrixSdkProvider } from "@matrix-os/contracts";
import type {
  CanonicalProviderCatalog,
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderOptionDescriptor,
  AiProviderLocalObservation,
} from "@matrix-os/contracts";

export interface CanonicalProviderChoice {
  instanceId: string;
  driverKind: CanonicalProviderDriverKind;
  harnessLabel: string;
  connectionLabel?: string;
  modelId: string;
  modelLabel: string;
  interactionMode: string;
  interactionModes: string[];
  permissionMode: string;
  permissionModes: string[];
  options: CanonicalProviderOptionDescriptor[];
  selectedOptions: Array<{ id: string; value: string | boolean }>;
  supportsFileAttachments: boolean;
  supportsCompanyDriveContext?: boolean;
}

const MANAGED_GLM_MODEL_ID = "cloudflare:@cf/zai-org/glm-5.3-flash";

function isManagedGlmInstance(instance: CanonicalProviderInstanceDescriptor): boolean {
  return instance.connectionLabel === "Matrix AI"
    && instance.models.some((model) => (
      model.id === MANAGED_GLM_MODEL_ID && model.availability === "available"
    ));
}

export function orderCanonicalProviderInstancesForDefault(
  instances: readonly CanonicalProviderInstanceDescriptor[],
): CanonicalProviderInstanceDescriptor[] {
  return instances
    .map((instance, index) => ({ instance, index }))
    .sort((left, right) => {
      const managedPiPriority = Number(right.instance.driverKind === "matrix_pi" && right.instance.availability === "available")
        - Number(left.instance.driverKind === "matrix_pi" && left.instance.availability === "available");
      const priority = Number(isManagedGlmInstance(right.instance))
        - Number(isManagedGlmInstance(left.instance));
      return managedPiPriority || priority || left.index - right.index;
    })
    .map(({ instance }) => instance);
}

function defaultOptionValue(
  option: CanonicalProviderOptionDescriptor,
): string | boolean | undefined {
  if (option.defaultValue !== undefined) return option.defaultValue;
  if (option.kind === "boolean") return false;
  return option.values?.[0]?.value;
}

function selectedOptionsFor(
  instance: CanonicalProviderInstanceDescriptor,
  modelId: string,
): CanonicalProviderChoice["selectedOptions"] {
  const defaults = instance.defaultSelection?.model === modelId
    ? instance.defaultSelection.options ?? []
    : [];
  return instance.options.flatMap((descriptor) => {
    const selected = defaults.find((option) => option.id === descriptor.id)?.value;
    const value = selected ?? defaultOptionValue(descriptor);
    return value === undefined ? [] : [{ id: descriptor.id, value }];
  });
}

export function canonicalProviderAvailabilityLabel(instance: CanonicalProviderInstanceDescriptor): string {
  if (isLegacyMatrixSdkProvider(instance)) return "Unavailable";
  const label = canonicalProviderAvailabilityReasonLabel(instance);
  return label === "Available" && (instance.driverKind === "codex" || instance.localObservation !== undefined)
    ? codexLocalObservationLabel(instance.localObservation) : label;
}

/** Preserve a bound route while reporting why it cannot execute. */
export function canonicalProviderUnavailableSelectionLabel(instance?: CanonicalProviderInstanceDescriptor | null, modelId?: string): string {
  return instance && !isLegacyMatrixSdkProvider(instance) && instance.models.some(model => model.id === modelId) && canonicalProviderFundingState(instance) === "credit_reserved"
    ? "Credit reserved" : "Unavailable";
}

export function codexLocalObservationLabel(observation?: AiProviderLocalObservation): string {
  const checkedAt = observation?.checkedAt ? Date.parse(observation.checkedAt) : NaN;
  const staleAfter = observation?.staleAfter ? Date.parse(observation.staleAfter) : NaN;
  const now = Date.now();
  if (!Number.isFinite(checkedAt) || !Number.isFinite(staleAfter)
    || checkedAt > now || staleAfter <= checkedAt) return "Access not verified";
  if (staleAfter <= now) return observation?.state === "present_unverified"
    ? "Local login last found; access not verified" : "Access not verified";
  if (observation?.state === "present_unverified") return "Local login found; access not verified";
  if (observation?.state === "absent") return "Local login missing";
  return "Access not verified";
}

export function deriveCanonicalProviderChoices(
  catalog: CanonicalProviderCatalog,
): CanonicalProviderChoice[] {
  return orderCanonicalProviderInstancesForDefault(catalog.instances).flatMap((instance) => {
    if (isLegacyMatrixSdkProvider(instance) || instance.availability !== "available") return [];
    const interactionMode = instance.supports.interactionModes[0];
    const permissionMode = instance.supports.permissionModes[0];
    if (!interactionMode || !permissionMode) return [];
    const managedExecution = instance.driverKind === "matrix_pi" && instance.id === "matrix_pi_default";
    const harnessLabel = managedExecution ? "Matrix AI" : instance.displayName;
    return instance.models.flatMap((model) => model.availability === "available" ? [{
      instanceId: instance.id,
      driverKind: instance.driverKind,
      harnessLabel,
      ...(instance.connectionLabel ? { connectionLabel: instance.connectionLabel } : {}),
      modelId: model.id,
      modelLabel: model.displayName,
      interactionMode,
      interactionModes: [...instance.supports.interactionModes],
      permissionMode,
      permissionModes: [...instance.supports.permissionModes],
      options: [...instance.options],
      selectedOptions: selectedOptionsFor(instance, model.id),
      supportsCompanyDriveContext: instance.supports.resources.includes("organization_drive"),
      supportsFileAttachments: instance.supports.attachments.some((kind) => kind === "file" || kind === "image"),
    }] : []);
  });
}
