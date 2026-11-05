/**
 * S08 / T044: the owner-source decision the shared AI runtime consults before
 * it prepares a provider adapter for a queued shared run.
 *
 * The decision comes from the scope's execution policy: the owner's selected
 * V3 source and harness, the effective submit mode for the requesting member
 * and the current policy revision. A scope without a policy is unavailable:
 * no run may execute on the owner's default kernel credential without an
 * explicit owner selection. Any refusal is a preparation error that keeps the
 * queued request in place; nothing falls back to another source, and the
 * owner's private provider session is never consulted.
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type {
  AiProviderSnapshotV3,
  CanonicalProviderDriverKind,
  CollaborationSharedHarness,
} from "@matrix-os/contracts";
import { SharedChatRunPreparationError } from "../chat/shared-execution-coordinator.js";
import { KernelCredentialAccessSourceIdSchema, type KernelCredentialAccessSourceId } from "../kernel-credentials.js";
import type { OwnerAccountEligibility, OwnerProviderSnapshotSource } from "./account-eligibility.js";
import { resolveExecutionScope, type CollaborationExecutionPolicyRepository } from "./execution-policy.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationRunBindingRepository } from "./run-account-binding.js";

export interface SharedRunOwnerSourceInput {
  scopeId: string;
  chatId: string;
  ownerId: string;
  requestingActorId: string;
  driverKind: CanonicalProviderDriverKind;
}

export interface SharedRunOwnerSourceDecision {
  authorityKind: "provider_settings_active" | "standalone_policy";
  policyRevision: string;
  /** Provider Settings V3 revision used for this request; project runs never treat it as project policy. */
  settingsRevision: string;
  /** Digest of the exact active tuple plus its source/catalog generations. */
  routeGeneration: string;
  harness: CollaborationSharedHarness;
  providerInstanceId: string;
  /** Exact Provider Settings access-source id, including non-kernel Codex sources. */
  providerAccessSourceId: string;
  /** The owner's selected access source when the kernel credential resolver knows it; null for non-Anthropic sources. */
  accessSourceId: KernelCredentialAccessSourceId | null;
  allowedModelIds: readonly string[];
  /** Deterministic model selected by the owner policy for this run. */
  modelId: string;
  effectiveSubmitMode: "members" | "owner_only";
}

const DRIVER_BY_HARNESS: Readonly<Record<CollaborationSharedHarness, CanonicalProviderDriverKind>> = Object.freeze({
  codex: "codex",
  claude_code: "claude_code",
});

function fresh(staleAfter: string | null, now: number): boolean {
  return staleAfter === null || Date.parse(staleAfter) > now;
}

/**
 * Resolves exactly the owner's global Provider Settings V3 `active` tuple.
 * It never scans for an alternate ready source, Instance, or model.
 */
export function resolveCurrentOwnerRoute(
  snapshot: AiProviderSnapshotV3,
  now = Date.now(),
): SharedRunOwnerSourceDecision | null {
  const { providerInstanceId, accessSourceId: providerAccessSourceId, modelId } = snapshot.active;
  if (!providerInstanceId || !providerAccessSourceId || !modelId) return null;
  const source = snapshot.accessSources.find((candidate) => candidate.id === providerAccessSourceId);
  const instance = snapshot.instances.find((candidate) => candidate.id === providerInstanceId);
  const model = snapshot.models.find((candidate) => candidate.id === modelId);
  if (!source || !instance || !model
    || source.state !== "ready" || !fresh(source.staleAfter, now)
    || instance.readiness.state !== "ready" || !fresh(instance.readiness.staleAfter, now)
    || instance.accessSourceId !== source.id
    || !instance.modelIds.includes(model.id)
    || !source.eligibleModelIds.includes(model.id)
    || !model.eligibleAccessSourceIds.includes(source.id)
    || model.status === "retired" || model.status === "unavailable") return null;
  const harness = instance.driverId === "codex"
    ? "codex" as const
    : instance.driverId === "claude_code" || instance.driverId === "kernel"
      ? "claude_code" as const
      : null;
  if (!harness) return null;
  const parsed = KernelCredentialAccessSourceIdSchema.safeParse(source.id);
  if (harness === "claude_code" && !parsed.success) return null;
  const settingsRevision = String(snapshot.revision);
  const routeGeneration = createHash("sha256").update(JSON.stringify({
    providerInstanceId,
    providerAccessSourceId,
    modelId,
    sourcePolicyVersion: source.policyVersion,
    instanceCatalogVersion: instance.catalogVersion,
    modelCatalogVersion: model.catalogVersion,
  })).digest("hex");
  return {
    authorityKind: "provider_settings_active",
    // Kept only for the existing standalone-compatible binding seam. Project
    // runs persist settingsRevision separately and never read a project policy.
    policyRevision: settingsRevision,
    settingsRevision,
    routeGeneration,
    harness,
    providerInstanceId,
    providerAccessSourceId,
    accessSourceId: parsed.success ? parsed.data : null,
    allowedModelIds: [modelId],
    modelId,
    effectiveSubmitMode: "members",
  };
}

/** Dispatch/credential fence for the immutable route captured at admission. */
export function currentOwnerRouteMatches(
  snapshot: AiProviderSnapshotV3,
  expected: SharedRunOwnerSourceDecision,
  now = Date.now(),
): boolean {
  const current = resolveCurrentOwnerRoute(snapshot, now);
  return current !== null && sameOwnerRoute(current, expected);
}

function sameOwnerRoute(current: SharedRunOwnerSourceDecision, expected: SharedRunOwnerSourceDecision): boolean {
  return current.routeGeneration === expected.routeGeneration
    && current.harness === expected.harness
    && current.providerInstanceId === expected.providerInstanceId
    && current.providerAccessSourceId === expected.providerAccessSourceId
    && current.modelId === expected.modelId;
}

/**
 * Whether the owner's selected source can admit queued work right now:
 * `missing` without a policy for this owner, `paused` while the selected
 * source is not ready (exhausted, expired, disabled), `ready` otherwise.
 * `paused` keeps requests queued instead of draining them into `unavailable`.
 */
export type SharedRunOwnerSourceAdmission = "ready" | "paused" | "missing";

export class SharedRunOwnerSource {
  readonly bindings: CollaborationRunBindingRepository;
  private readonly policies: CollaborationExecutionPolicyRepository;
  private readonly eligibility: OwnerAccountEligibility;
  private readonly db?: Kysely<OwnerCollaborationDatabase>;
  private readonly snapshots?: OwnerProviderSnapshotSource;
  private readonly now: () => number;

  constructor(options: {
    policies: CollaborationExecutionPolicyRepository;
    eligibility: OwnerAccountEligibility;
    bindings: CollaborationRunBindingRepository;
    db?: Kysely<OwnerCollaborationDatabase>;
    snapshots?: OwnerProviderSnapshotSource;
    now?: () => number;
  }) {
    this.policies = options.policies;
    this.eligibility = options.eligibility;
    this.bindings = options.bindings;
    this.db = options.db;
    this.snapshots = options.snapshots;
    this.now = options.now ?? Date.now;
  }

  async admission(input: { scopeId: string; ownerId: string }): Promise<SharedRunOwnerSourceAdmission> {
    const current = await this.projectAuthority(input);
    if (current !== undefined) return current ? "ready" : "missing";
    const policy = await this.policies.resolve(input.scopeId);
    if (!policy || policy.ownerId !== input.ownerId) return "missing";
    const resolution = await this.eligibility.resolveSelection(policy.ownerId, policy.source);
    if (!resolution.ok || resolution.source.harness !== policy.source.harness) return "missing";
    return resolution.available ? "ready" : "paused";
  }

  /**
   * Throws `SharedChatRunPreparationError("unavailable")` when the scope has
   * no execution policy or the owner's source cannot serve the run, and
   * `SharedChatRunPreparationError("unauthorized")` when the persisted policy
   * lacks the owner's provider-terms acknowledgement. There is no null path:
   * a policy is mandatory.
   */
  async prepare(input: SharedRunOwnerSourceInput): Promise<SharedRunOwnerSourceDecision> {
    const decision = await this.authority({ scopeId: input.scopeId, ownerId: input.ownerId });
    if (input.requestingActorId !== input.ownerId && decision.effectiveSubmitMode !== "members") {
      throw new SharedChatRunPreparationError("unauthorized");
    }
    if (DRIVER_BY_HARNESS[decision.harness] !== input.driverKind) {
      throw new SharedChatRunPreparationError("unavailable");
    }
    return decision;
  }

  /** Resolve the exact owner-controlled source and model before queue admission. */
  async authority(input: { scopeId: string; ownerId: string }): Promise<SharedRunOwnerSourceDecision> {
    const current = await this.projectAuthority(input);
    if (current !== undefined) {
      if (!current) throw new SharedChatRunPreparationError("unavailable");
      return current;
    }
    const policy = await this.policies.resolve(input.scopeId);
    if (!policy) throw new SharedChatRunPreparationError("unavailable");
    if (policy.ownerId !== input.ownerId) {
      throw new SharedChatRunPreparationError("unavailable");
    }
    const resolution = await this.eligibility.resolveSelection(policy.ownerId, policy.source);
    if (!resolution.ok || !resolution.available || resolution.source.harness !== policy.source.harness) {
      throw new SharedChatRunPreparationError("unavailable");
    }
    const allowedModelIds = policy.allowedModelIds.filter((modelId) => resolution.modelIds.includes(modelId));
    const modelId = allowedModelIds[0];
    if (!modelId) throw new SharedChatRunPreparationError("unavailable");
    const parsed = KernelCredentialAccessSourceIdSchema.safeParse(policy.source.accessSourceId);
    return {
      authorityKind: "standalone_policy",
      policyRevision: policy.revision,
      settingsRevision: policy.revision,
      routeGeneration: createHash("sha256").update(JSON.stringify({
        policyRevision: policy.revision,
        source: policy.source,
        modelId,
      })).digest("hex"),
      harness: policy.source.harness,
      providerInstanceId: policy.source.providerInstanceId,
      providerAccessSourceId: policy.source.accessSourceId,
      accessSourceId: parsed.success ? parsed.data : null,
      allowedModelIds,
      modelId,
      effectiveSubmitMode: policy.effectiveSubmitMode,
    };
  }

  /** Re-read Provider Settings immediately before broker credential resolution. */
  async matchesCurrent(input: {
    scopeId: string;
    ownerId: string;
    expected: SharedRunOwnerSourceDecision;
  }): Promise<boolean> {
    const current = await this.projectAuthority(input);
    if (current !== undefined) return current !== null && sameOwnerRoute(current, input.expected);
    try {
      const decision = await this.authority(input);
      return decision.routeGeneration === input.expected.routeGeneration;
    } catch (error: unknown) {
      console.warn("[collaboration] shared owner route revalidation failed",
        error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }

  /** Undefined means standalone compatibility; null means a project route is unavailable. */
  private async projectAuthority(
    input: { scopeId: string; ownerId: string },
  ): Promise<SharedRunOwnerSourceDecision | null | undefined> {
    if (!this.db || !this.snapshots) return undefined;
    const execution = await resolveExecutionScope(this.db, input.scopeId);
    if (!execution || execution.ref.kind !== "project") return undefined;
    if (execution.scope.owner_id !== input.ownerId) return null;
    return resolveCurrentOwnerRoute(await this.snapshots.getSnapshotV3(input.ownerId), this.now());
  }
}
