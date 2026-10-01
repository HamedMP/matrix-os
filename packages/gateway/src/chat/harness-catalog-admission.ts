import { isRunnableGenericHarnessCredentialRoute, isLocallyObservedNativeHarnessRoute, isSupportedGenericHarnessCredentialRoute,
  type AiProviderSnapshotV3, type CanonicalProviderDriverKind, type CanonicalProviderInstanceDescriptor, type CanonicalProviderSetupAction,
  type ProviderAccessSource, type ProviderHarnessInstance, type ProviderHarnessKind, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { hermesNativeModelId } from "../ai-providers/hermes-native-catalog.js";
import { configuredHarnessInstanceFromAiSnapshot, unavailableInstance, unavailableReasonFor } from "./configured-harness-catalog.js";
type InstanceDraft = Omit<CanonicalProviderInstanceDescriptor, "catalogRevision">;

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

/** Preserve saved intent within runtime bounds; admission remains independent. */
export function configuredSystemModel(settings: ProviderSettingsSnapshot | null, kind: "hermes" | "openclaw"): string | null {
  const enabled = settings?.harnesses.filter(harness => harness.harness === kind && harness.enabled) ?? [];
  if (enabled.length !== 1) return null;
  const harness = enabled[0]!;
  const source = settings?.accessSources.find(candidate => candidate.id === harness.accessSourceId);
  if (!isSupportedGenericHarnessCredentialRoute(harness, source)) return null;
  const native = source?.kind === "harness_profile" && kind === "hermes"
    ? hermesNativeModelId(harness, source) : undefined;
  return native === null ? null : `${harness.route.providerId}:${native ?? harness.route.modelId}`;
}


function configuredSystemInstance(
  instance: InstanceDraft,
  harness: ProviderHarnessInstance,
  source?: ProviderAccessSource,
): InstanceDraft {
  if (instance.availability !== "available") {
    return unavailableInstance(instance, unavailableReasonFor(instance));
  }
  const nativeModel = source?.kind === "harness_profile" && harness.harness === "hermes"
    ? hermesNativeModelId(harness, source) : undefined;
  if (nativeModel === null) return unavailableInstance(instance, "runtime_not_runnable");
  const modelId = `${harness.route.providerId}:${nativeModel ?? harness.route.modelId}`;
  const model = instance.models.find((candidate) =>
    candidate.id === modelId && candidate.availability === "available"
  );
  if (!model) return unavailableInstance(instance, "runtime_unavailable");
  return {
    ...instance,
    models: nativeModel !== undefined
      ? instance.models.filter((candidate) => source!.eligibleModelIds.includes(candidate.id)) : [model],
    defaultSelection: { instanceId: instance.id, model: model.id },
    unavailabilityReason: undefined,
  };
}

export function applyHarnessSettings(input: {
  systemRepairAction: (kind: "hermes" | "openclaw") => CanonicalProviderSetupAction;
  now: Date;
  instances: InstanceDraft[];
  settings: ProviderSettingsSnapshot | null;
  settingsRequired: boolean;
  settingsAvailable: boolean;
  includeSettingsSetupActions?: boolean;
  executableDriverKinds?: readonly CanonicalProviderDriverKind[];
  credentialedDriverKinds?: readonly CanonicalProviderDriverKind[];
  aiSnapshot?: AiProviderSnapshotV3;
}): InstanceDraft[] {
  const projected = input.instances.map((instance) => {
    if (instance.driverKind === "codex" || instance.driverKind === "claude_code") {
      const harnessKind = instance.driverKind === "codex" ? "codex" : "claude";
      if (input.executableDriverKinds !== undefined && !input.executableDriverKinds.includes(instance.driverKind)) {
        return unavailableInstance(instance, "runtime_not_runnable");
      }
      if (input.settingsRequired && !input.settingsAvailable && instance.availability !== "setup_required") {
        return unavailableInstance(instance, "settings_unavailable");
      }
      const saved = input.settings?.harnesses.filter((harness) => harness.harness === harnessKind) ?? [];
      const enabled = saved.filter((harness) => harness.configuredEnabled ?? harness.enabled);
      if (input.settingsAvailable && saved.length > 0 && enabled.length === 0) {
        return unavailableInstance(instance, "disabled_in_settings");
      }
      const selectedSourceMatches = instance.driverKind === "codex" && input.settingsAvailable
        && enabled.length === 1
        && enabled[0]!.accessSourceId === "owner_openai_profile";
      const localObservation = selectedSourceMatches
        ? input.aiSnapshot?.accessSources.find((source) => source.id === "owner_openai_profile")?.localObservation
        : undefined;
      return { ...instance, ...(localObservation ? { localObservation } : {}) };
    }
    const generic = genericHarnessKind(instance.driverKind);
    const settingsHarness = settingsHarnessKind(instance.driverKind);
    const systemHarness = systemHarnessKind(instance.driverKind);
    if ((settingsHarness !== null || systemHarness === "hermes") && input.settingsRequired && (!input.settingsAvailable || input.settings === null)) {
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
    const configuredHarnesses = configuredHarness !== null && input.settingsAvailable && input.settings !== null
      ? input.settings.harnesses.filter((harness) => harness.harness === configuredHarness)
      : [];
    const enabledHarnesses = configuredHarnesses.filter((harness) => harness.enabled);
    const executable = input.executableDriverKinds === undefined
      || input.executableDriverKinds.includes(instance.driverKind);
    const nativeTerminalProfile = (generic === "pi" || generic === "opencode")
      && instance.availability === "available"
      && input.credentialedDriverKinds?.includes(generic);
    // A generated native route cannot override explicit negative CLI admission.
    if ((generic === "pi" || generic === "opencode") && configuredHarnesses.length > 0
      && configuredHarnesses.every((harness) => harness.enablementOrigin === "generated_default")
      && instance.availability !== "available") {
      return unavailableInstance(instance, unavailableReasonFor(instance));
    }
    // configuredEnabled is the owner's saved switch; enabled is only the
    // current route's operational projection. Native fallback cannot bypass
    // an explicit off switch, even when that runtime is stopped.
    if (configuredHarnesses.length > 0
      && configuredHarnesses.every((harness) => harness.configuredEnabled === false)
      && instance.availability !== "setup_required") {
      return { ...unavailableInstance(instance, "disabled_in_settings"),
        setupActions: input.includeSettingsSetupActions && executable
          ? instance.setupActions : [] };
    }
    if (settingsHarness !== null && input.settingsRequired && enabledHarnesses.length === 0) {
      if ((generic === "pi" || generic === "opencode") && configuredHarnesses.length > 0
        && configuredHarnesses.every((harness) => harness.enablementOrigin === "generated_default")) {
        return unavailableInstance(instance, "runtime_unavailable");
      }
      if ((generic === "pi" || generic === "opencode")
        && configuredHarnesses.some((harness) => harness.routeAvailability === "catalog_unavailable")) {
        return unavailableInstance(instance, "runtime_unavailable");
      }
      const observedSavedNativeRoute = configuredHarnesses.some((harness) => input.settings?.accessSources.some((source) =>
        source.kind === "harness_profile" && source.harness === harness.harness
        && source.providerId === harness.route.providerId && source.eligibleModelIds.includes(harness.route.modelId)
        && source.localObservation !== undefined));
      if (observedSavedNativeRoute) return unavailableInstance(instance, "runtime_unavailable");
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
    const systemSource = enabledHarness
      ? input.settings?.accessSources.find((source) => source.id === enabledHarness.accessSourceId) : undefined;
    if (systemHarness !== null && configuredHarnesses.length > 0) {
      if (enabledHarnesses.length !== 1 || !enabledHarness
        || !isSupportedGenericHarnessCredentialRoute(enabledHarness, systemSource)) {
        return unavailableInstance(configuredInstance, "runtime_not_runnable");
      }
      // Local native inventory cannot override an explicit negative owner route.
      // Unknown native authentication remains eligible for an owner attempt.
      if (enabledHarness.authState === "unauthenticated") {
        return unavailableInstance(configuredInstance, "authentication_required");
      }
      if (enabledHarness.connectivity === "offline") {
        return unavailableInstance(configuredInstance, "runtime_unavailable");
      }
      if (systemSource?.kind === "harness_profile") {
        if (!isLocallyObservedNativeHarnessRoute(enabledHarness, systemSource, input.now) || !executable) {
          return unavailableInstance(configuredInstance, "runtime_not_runnable");
        }
        return configuredSystemInstance(configuredInstance, enabledHarness, systemSource);
      }
    }
    // A selected system runtime has a live provider/model inventory. Keep that
    // inventory authoritative instead of replacing it with a stale settings route.
    if (systemHarness !== null && instance.availability === "available" && executable) {
      return { ...instance, unavailabilityReason: undefined };
    }
    if (enabledHarnesses.length > 1) {
      return unavailableInstance(instance, "multiple_profiles_unsupported");
    }
    const locallyObservedNative = enabledHarness && isLocallyObservedNativeHarnessRoute(enabledHarness,
      input.settings?.accessSources.find((source) => source.id === enabledHarness.accessSourceId), input.now);
    if (enabledHarness && systemHarness === null && !locallyObservedNative
      && (enabledHarness.authState !== "authenticated" || enabledHarness.accessSourceId === null)) {
      return unavailableInstance(configuredInstance, "authentication_required");
    }
    if (enabledHarness && systemHarness === null && !locallyObservedNative && enabledHarness.connectivity !== "online") {
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
          setupActions: [installAction ?? input.systemRepairAction(instance.driverKind)],
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
  return projected.map(instance => {
    const kind = instance.driverKind === "claude_code" ? "claude" : instance.driverKind;
    const harnesses = input.settings?.harnesses.filter(harness => harness.harness === kind) ?? [];
    if (harnesses.length !== 1) return instance;
    const source = input.settings?.accessSources.find(candidate => candidate.id === harnesses[0]!.accessSourceId);
    if (source?.kind !== "matrix_gateway") return instance;
    const fresh = source.readiness.staleAfter === null
      || Date.parse(source.readiness.staleAfter) > input.now.getTime();
    return { ...instance, connectionLabel: "Matrix AI", connectionState: instance.availability === "available"
      ? "ready" as const : fresh && source.readiness.safeReason === "credit_required" ? "credit_required" as const : "unavailable" as const };
  });
}
