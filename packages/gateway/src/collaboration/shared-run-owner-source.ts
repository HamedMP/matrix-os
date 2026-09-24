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
import type { CanonicalProviderDriverKind, CollaborationSharedHarness } from "@matrix-os/contracts";
import { SharedChatRunPreparationError } from "../chat/shared-execution-coordinator.js";
import { KernelCredentialAccessSourceIdSchema, type KernelCredentialAccessSourceId } from "../kernel-credentials.js";
import type { OwnerAccountEligibility } from "./account-eligibility.js";
import type { CollaborationExecutionPolicyRepository } from "./execution-policy.js";
import type { CollaborationRunBindingRepository } from "./run-account-binding.js";

export interface SharedRunOwnerSourceInput {
  scopeId: string;
  chatId: string;
  ownerId: string;
  requestingActorId: string;
  driverKind: CanonicalProviderDriverKind;
}

export interface SharedRunOwnerSourceDecision {
  policyRevision: string;
  harness: CollaborationSharedHarness;
  providerInstanceId: string;
  /** The owner's selected access source when the kernel credential resolver knows it; null for non-Anthropic sources. */
  accessSourceId: KernelCredentialAccessSourceId | null;
  allowedModelIds: readonly string[];
  effectiveSubmitMode: "members" | "owner_only";
}

const DRIVER_BY_HARNESS: Readonly<Record<CollaborationSharedHarness, CanonicalProviderDriverKind>> = Object.freeze({
  codex: "codex",
  claude_code: "claude_code",
});

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

  constructor(options: {
    policies: CollaborationExecutionPolicyRepository;
    eligibility: OwnerAccountEligibility;
    bindings: CollaborationRunBindingRepository;
  }) {
    this.policies = options.policies;
    this.eligibility = options.eligibility;
    this.bindings = options.bindings;
  }

  async admission(input: { scopeId: string; ownerId: string }): Promise<SharedRunOwnerSourceAdmission> {
    const policy = await this.policies.resolve(input.scopeId);
    if (!policy || policy.ownerId !== input.ownerId) return "missing";
    const resolution = await this.eligibility.resolveSelection(policy.ownerId, policy.source);
    if (!resolution.ok || resolution.source.harness !== policy.source.harness) return "missing";
    return resolution.available ? "ready" : "paused";
  }

  /**
   * Throws `SharedChatRunPreparationError("unavailable")` when the scope has
   * no execution policy or the owner's source cannot serve the run, and
   * `SharedChatRunPreparationError("unauthorized")` when a member submits on
   * an owner-only scope. There is no null path: a policy is mandatory.
   */
  async prepare(input: SharedRunOwnerSourceInput): Promise<SharedRunOwnerSourceDecision> {
    const policy = await this.policies.resolve(input.scopeId);
    if (!policy) throw new SharedChatRunPreparationError("unavailable");
    if (policy.ownerId !== input.ownerId) {
      throw new SharedChatRunPreparationError("unavailable");
    }
    if (input.requestingActorId !== policy.ownerId && policy.effectiveSubmitMode !== "members") {
      throw new SharedChatRunPreparationError("unauthorized");
    }
    if (DRIVER_BY_HARNESS[policy.source.harness] !== input.driverKind) {
      throw new SharedChatRunPreparationError("unavailable");
    }
    const resolution = await this.eligibility.resolveSelection(policy.ownerId, policy.source);
    if (!resolution.ok || !resolution.available || resolution.source.harness !== policy.source.harness) {
      throw new SharedChatRunPreparationError("unavailable");
    }
    const parsed = KernelCredentialAccessSourceIdSchema.safeParse(policy.source.accessSourceId);
    return {
      policyRevision: policy.revision,
      harness: policy.source.harness,
      providerInstanceId: policy.source.providerInstanceId,
      accessSourceId: parsed.success ? parsed.data : null,
      allowedModelIds: policy.allowedModelIds.filter((modelId) => resolution.modelIds.includes(modelId)),
      effectiveSubmitMode: policy.effectiveSubmitMode,
    };
  }
}
