/**
 * S08 / T041–T042: owner account eligibility over the existing Provider V3
 * snapshot.
 *
 * The owner's selected source is used exactly as the owner's own runs use it.
 * This module only answers "does the owner have this source, which shared
 * harness serves it, which models may run on it, and is it usable right
 * now". It never enforces provider eligibility (a product decision recorded
 * in spec.md), never stores participant accounts and never copies tokens.
 */
import type {
  AiProviderSnapshotV3,
  CollaborationSharedHarness,
  CollaborationSourceKind,
  CollaborationSourceSelection,
} from "@matrix-os/contracts";
import type { ReadinessProbes } from "./readiness-evaluator.js";

export interface OwnerProviderSnapshotSource {
  /** The owner's current Provider V3 snapshot; throws when it cannot be read. */
  getSnapshotV3(ownerId: string): Promise<AiProviderSnapshotV3>;
}

export type OwnerSourceResolution =
  | {
    ok: true;
    source: CollaborationSourceSelection;
    sourceKind: CollaborationSourceKind;
    /** Models the owner may run on this source through this instance. */
    modelIds: readonly string[];
    defaultModelId: string | null;
    /** False when the source or instance is not ready (expired, exhausted, disabled...). */
    available: boolean;
  }
  | { ok: false; reason: "unknown_source" | "unsupported_harness" };

const HARNESS_BY_DRIVER: Readonly<Record<string, CollaborationSharedHarness>> = Object.freeze({
  claude_code: "claude_code",
  codex: "codex",
});

/** Maps a V3 driver id to the shared harness that executes it; null when no shared adapter exists. */
export function sharedHarnessForDriver(driverId: string): CollaborationSharedHarness | null {
  return HARNESS_BY_DRIVER[driverId] ?? null;
}

export class OwnerAccountEligibility {
  private readonly snapshots: OwnerProviderSnapshotSource;

  constructor(options: { snapshots: OwnerProviderSnapshotSource }) {
    this.snapshots = options.snapshots;
  }

  async resolveSelection(
    ownerId: string,
    selection: { accessSourceId: string; providerInstanceId: string },
  ): Promise<OwnerSourceResolution> {
    const snapshot = await this.snapshots.getSnapshotV3(ownerId);
    const source = snapshot.accessSources.find((candidate) => candidate.id === selection.accessSourceId);
    const instance = snapshot.instances.find((candidate) => candidate.id === selection.providerInstanceId);
    if (!source || !instance || instance.accessSourceId !== source.id) {
      return { ok: false, reason: "unknown_source" };
    }
    const harness = sharedHarnessForDriver(instance.driverId);
    if (!harness) return { ok: false, reason: "unsupported_harness" };
    const modelIds = source.eligibleModelIds.length === 0
      ? instance.modelIds
      : instance.modelIds.filter((modelId) => source.eligibleModelIds.includes(modelId));
    return {
      ok: true,
      source: { accessSourceId: source.id, providerInstanceId: instance.id, harness },
      sourceKind: source.fundingKind,
      modelIds,
      defaultModelId: instance.defaultModelId !== null && modelIds.includes(instance.defaultModelId)
        ? instance.defaultModelId
        : modelIds[0] ?? null,
      available: source.state === "ready" && instance.readiness.state === "ready",
    };
  }
}

interface ReadinessPolicySource {
  resolve(scopeId: string): Promise<{ ownerId: string; source: CollaborationSourceSelection } | null>;
  effectiveSubmitMode(scopeId: string): Promise<"members" | "owner_only">;
}

/**
 * S04 readiness probes for the two items S08 owns. A selected but unusable
 * source reports "not configured" so the share preview shows owner setup
 * instead of silently switching to another source.
 */
export function createOwnerSourceReadinessProbes(options: {
  policies: ReadinessPolicySource;
  eligibility: OwnerAccountEligibility;
}): Pick<ReadinessProbes, "aiSource" | "submitMode"> {
  return {
    async aiSource(subject) {
      const policy = await options.policies.resolve(subject.scopeId);
      if (!policy) return { configured: false };
      const resolution = await options.eligibility.resolveSelection(policy.ownerId, policy.source);
      if (!resolution.ok || !resolution.available) return { configured: false };
      return { configured: true, sourceKind: resolution.sourceKind };
    },
    async submitMode(subject) {
      return options.policies.effectiveSubmitMode(subject.scopeId);
    },
  };
}
