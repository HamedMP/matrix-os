import { CanonicalChatModelSelectionSchema, type CanonicalProviderDriverKind } from "@matrix-os/contracts";
import type { ScopeRuntimeCapability } from "./scope-runtime-client.js";
import { LEGACY_SCOPE_RUNTIME_PROFILE_POLICY, type GatewayScopeRuntimeProfilePolicy,
  type CollaborationAiExecutionEligibility } from "./scope-runtime-profile-policy.js";
import { createSandboxReadinessProbe } from "./sandbox-readiness.js";
import type { SharedChatSandboxManifestSource } from "./shared-ai-runtime.js";

/**
 * Shared AI is eligible only when the supervisor advertises the pinned
 * sandbox policy for `chat_ai` (the S07 readiness probe) and a manifest
 * source exists to mount an execution root. Without both, the scope reports
 * no eligibility instead of offering runs that would fail at launch.
 */
export async function deriveSharedAiEligibility(input: {
  client: { capability(): ScopeRuntimeCapability; profileCapability?(profileId: string): ScopeRuntimeCapability };
  sandboxManifests?: SharedChatSandboxManifestSource;
  matrixBotEnabled?: boolean;
  profilePolicy?: GatewayScopeRuntimeProfilePolicy;
}): Promise<CollaborationAiExecutionEligibility | null> {
  const policy = input.profilePolicy ?? LEGACY_SCOPE_RUNTIME_PROFILE_POLICY;
  const capability = input.client.capability();
  if (!capability.available || capability.profileId !== policy.sharedEligibility.profileId || !input.sandboxManifests) return null;
  if (!await createSandboxReadinessProbe({ client: input.client }).sandboxRunsSupported()) return null;
  const eligibility: CollaborationAiExecutionEligibility = {
    ...policy.sharedEligibility,
    adapters: policy.sharedEligibility.adapters.filter((expected) => capability.supportedAdapters.some((actual) =>
      actual.adapterId === expected.adapterId
      && actual.harnessVersion === expected.harnessVersion
      && actual.workloads.includes("chat_ai"))),
  };
  const bot = input.matrixBotEnabled ? input.client.profileCapability?.(policy.matrixBotEligibility.profileId) : undefined;
  if (bot?.available && bot.profileId === policy.matrixBotEligibility.profileId
    && bot.executionGeneration === capability.executionGeneration && bot.sandbox?.workloads.includes("bot_agent")
    && bot.supportedAdapters.some((adapter) => adapter.adapterId === policy.matrixBotEligibility.adapterId
      && adapter.harnessVersion === policy.matrixBotEligibility.harnessVersion && adapter.workloads.includes("bot_agent"))) {
    eligibility.matrixBot = policy.matrixBotEligibility;
  }
  return eligibility.adapters.length === 0 ? null : eligibility;
}

export function sharedDispatchFenceMatches(
  current: {
    owner_id: string;
    resource_id: string;
    execution_generation: number | null;
    execution_eligibility: unknown;
    lifecycle: string;
    bound_driver_kind: string | null;
    bound_instance_id: string | null;
    current_selection: unknown;
  } | undefined,
  expected: {
    ownerId: string;
    chatId: string;
    executionGeneration: number;
    executionEligibility: unknown;
    driverKind: CanonicalProviderDriverKind;
    selection: { instanceId: string; model: string };
  },
  policy = LEGACY_SCOPE_RUNTIME_PROFILE_POLICY,
): boolean {
  if (!current || current.owner_id !== expected.ownerId || current.resource_id !== expected.chatId
    || current.lifecycle !== "active"
    || Number(current.execution_generation) !== expected.executionGeneration
    || current.bound_driver_kind !== expected.driverKind
    || current.bound_instance_id !== expected.selection.instanceId
    || !policy.supportsDriver(expected.executionEligibility, expected.driverKind, expected.selection.instanceId)
    || !policy.eligibilityEquals(current.execution_eligibility, expected.executionEligibility)) return false;
  try {
    const raw = typeof current.current_selection === "string"
      ? JSON.parse(current.current_selection) as unknown
      : current.current_selection;
    const selection = CanonicalChatModelSelectionSchema.parse(raw);
    return JSON.stringify(selection) === JSON.stringify(expected.selection);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw new Error("Invalid shared execution selection");
    return false;
  }
}
