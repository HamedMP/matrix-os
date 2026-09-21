/**
 * S04 / T021, T024: one deny-wins evaluator for whole-project presets.
 *
 * Order: scope exists and is available → organization precondition (S20,
 * fail-closed; a resource without an organization or an actor without fresh
 * membership denies before any allow) → owner → union of the actor's
 * applicable allows (member grant, activated organization grant) →
 * migration ceilings for legacy-dispositioned grants. No implicit editor
 * funding, no admin content privilege, no selectors. A policy lookup failure
 * is `unavailable`, never an allow and never not-found.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import {
  CollaborationEffectiveAccessSchema,
  expandCollaborationPreset,
  type CollaborationAccessReason,
  type CollaborationCapabilityAction,
  type CollaborationEffectiveAccess,
  type CollaborationPreset,
} from "@matrix-os/contracts";
import { CollaborationAuthorizationError } from "./authority-error.js";
import type {
  ActorGrantResolution,
  CollaborationCapabilityRepository,
  CreateGrantInput,
  GrantMutationResult,
  GrantRow,
  PatchGrantPresetInput,
  RevokeGrantInput,
} from "./capability-repository.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { OrganizationPrecondition } from "./organization-precondition.js";
import { CollaborationRepositoryError } from "./repository-shared.js";

/** Contract limit: organization evidence is valid 20 seconds from the authoritative request start. */
export const ORGANIZATION_EVIDENCE_DEADLINE_MS = 20_000;

const GIT_ACTIONS: readonly CollaborationCapabilityAction[] = ["git.commit", "git.push", "git.pr"];

/** Exact action ceiling of the old roles: a dispositioned editor never gains Git broker operations. */
export function legacyCeilingActions(ceiling: "editor" | "viewer"): ReadonlySet<CollaborationCapabilityAction> {
  if (ceiling === "viewer") return new Set(expandCollaborationPreset("viewer"));
  return new Set(expandCollaborationPreset("contributor").filter((action) => !GIT_ACTIONS.includes(action)));
}

export interface EffectiveAccessDecision {
  access: CollaborationEffectiveAccess;
  /** Exact enforced action set; equals the preset expansion unless a legacy ceiling narrowed it. */
  actions: ReadonlySet<CollaborationCapabilityAction>;
  ownerId: string;
  isOwner: boolean;
}

export interface CollaborationCapabilityEvaluatorOptions {
  db: Kysely<OwnerCollaborationDatabase>;
  grants: CollaborationCapabilityRepository;
  organizationPrecondition: OrganizationPrecondition;
  now?: () => Date;
  /** Monotonic membership evidence epoch recorded on activations; defaults to the request time in seconds. */
  evidenceEpoch?: () => number;
}

export class CollaborationCapabilityEvaluator {
  private readonly now: () => Date;
  private readonly evidenceEpoch: () => number;

  constructor(private readonly options: CollaborationCapabilityEvaluatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.evidenceEpoch = options.evidenceEpoch ?? (() => Math.floor(this.now().getTime() / 1_000));
  }

  async evaluateEffectiveAccess(input: { scopeId: string; actorId: string }): Promise<CollaborationEffectiveAccess> {
    return (await this.decide(input)).access;
  }

  /** Throws the shared authorization error unless the actor holds the exact action. */
  async requireAction(input: { scopeId: string; actorId: string; action: CollaborationCapabilityAction }): Promise<CollaborationEffectiveAccess> {
    const decision = await this.decide(input);
    if (decision.access.preset === null) {
      const reason = decision.access.reasons[0];
      if (reason === "scope_unavailable" || reason === "host_offline") {
        throw new CollaborationAuthorizationError("not_found", "Scope not found");
      }
      throw new CollaborationAuthorizationError("not_found", "Current membership is required");
    }
    if (!decision.actions.has(input.action)) {
      throw new CollaborationAuthorizationError("forbidden", "Preset does not allow this action");
    }
    return decision.access;
  }

  async decide(input: { scopeId: string; actorId: string }): Promise<EffectiveAccessDecision> {
    const now = this.now();
    // The advertised deadline is never later than the authoritative evidence or the contract's 20-second bound.
    let evidenceExpiresAt = new Date(now.getTime() + ORGANIZATION_EVIDENCE_DEADLINE_MS).toISOString();
    let resolution: ActorGrantResolution | null;
    try {
      resolution = await this.options.grants.resolveActorGrants(input.scopeId, input.actorId);
    } catch (error: unknown) {
      console.warn("[collaboration-capabilities] policy lookup failed", error instanceof Error ? error.name : "UnknownError");
      throw new CollaborationAuthorizationError("unavailable", "Collaboration policy is unavailable");
    }
    const deny = (reason: CollaborationAccessReason, ownerId = "", organizationId = "org_unavailable"): EffectiveAccessDecision => ({
      access: CollaborationEffectiveAccessSchema.parse({
        scopeId: input.scopeId, actorId: input.actorId, organizationId, preset: null, actions: [], reasons: [reason], evidenceExpiresAt,
      }),
      actions: new Set(),
      ownerId,
      isOwner: false,
    });
    if (!resolution) return deny("scope_unavailable");
    const { scope } = resolution;
    if (scope.membership_mode !== "direct") return deny("scope_unavailable", scope.owner_id);
    if (!scope.organization_id) return deny("organization_required", scope.owner_id);
    const organizationId = scope.organization_id;
    try {
      const evidence = await this.options.organizationPrecondition.require({ organizationId, actorId: input.actorId });
      const authoritative = Date.parse(evidence.expiresAt);
      if (Number.isFinite(authoritative) && authoritative < Date.parse(evidenceExpiresAt)) {
        evidenceExpiresAt = new Date(authoritative).toISOString();
      }
    } catch (error: unknown) {
      if (!(error instanceof CollaborationAuthorizationError)) throw error;
      return deny("precondition_denied", scope.owner_id, organizationId);
    }
    if (scope.lifecycle !== "shared" && scope.lifecycle !== "archived") return deny("scope_unavailable", scope.owner_id, organizationId);

    const allow = (preset: CollaborationPreset, actions: ReadonlySet<CollaborationCapabilityAction>, isOwner: boolean): EffectiveAccessDecision => {
      const narrowed = scope.lifecycle === "archived"
        ? new Set([...actions].filter((action) => expandCollaborationPreset("viewer").includes(action)))
        : actions;
      const wirePreset = presetContainedIn(narrowed);
      return {
        access: CollaborationEffectiveAccessSchema.parse({
          scopeId: input.scopeId, actorId: input.actorId, organizationId,
          preset: wirePreset, actions: [...expandCollaborationPreset(wirePreset)], reasons: [], evidenceExpiresAt,
        }),
        actions: narrowed,
        ownerId: scope.owner_id,
        isOwner,
      };
    };
    if (scope.owner_id === input.actorId) {
      return allow("contributor", new Set(expandCollaborationPreset("contributor")), true);
    }

    const union = new Set<CollaborationCapabilityAction>();
    let best: CollaborationPreset | null = null;
    const reasons: CollaborationAccessReason[] = [];
    const consider = (grant: GrantRow | null, activeForActor: boolean, pendingReason: CollaborationAccessReason): void => {
      if (!grant) return;
      if (grant.state === "revoked") { reasons.push("grant_revoked"); return; }
      if (grant.state === "expired" || (grant.expires_at !== null && new Date(grant.expires_at).getTime() <= now.getTime())) {
        reasons.push("grant_expired");
        return;
      }
      if (!activeForActor) { reasons.push(pendingReason); return; }
      const actions = grant.legacy_ceiling ? legacyCeilingActions(grant.legacy_ceiling) : new Set(expandCollaborationPreset(grant.preset));
      for (const action of actions) union.add(action);
      if (best === null || grant.preset === "contributor") best = grant.preset;
    };
    consider(resolution.memberGrant, resolution.memberGrant?.state === "active", "activation_required");
    consider(resolution.organizationGrant, resolution.activation?.state === "active", "activation_required");
    if (best === null) {
      return deny(reasons[0] ?? "membership_required", scope.owner_id, organizationId);
    }
    return allow(best, union, false);
  }

  /** Grant creation under the precondition: the owner and any member audience must hold fresh membership. */
  async createGrant(input: CreateGrantInput): Promise<GrantMutationResult> {
    const scope = await this.options.db.selectFrom("collaboration_scopes").select(["organization_id", "owner_id"])
      .where("id", "=", input.scopeId).where("deleted_at", "is", null).executeTakeFirst();
    if (!scope) throw new CollaborationAuthorizationError("not_found", "Scope not found");
    await this.options.organizationPrecondition.require({ organizationId: scope.organization_id, actorId: input.actorId });
    if (input.audience.kind === "member") {
      await this.options.organizationPrecondition.require({ organizationId: scope.organization_id, actorId: input.audience.actorId });
    }
    return this.options.grants.createGrant(input);
  }

  /**
   * Participants with fresh membership only: an actor whose membership ended is dropped even if
   * their activation row has not been swept yet, so departure never leaves them enumerable.
   */
  async listParticipants(scopeId: string): Promise<string[]> {
    const scope = await this.options.db.selectFrom("collaboration_scopes").select("organization_id")
      .where("id", "=", scopeId).where("deleted_at", "is", null).executeTakeFirst();
    if (!scope?.organization_id) return [];
    const candidates = await this.options.grants.listParticipants(scopeId);
    const fresh: string[] = [];
    for (const actorId of candidates) {
      try {
        await this.options.organizationPrecondition.require({ organizationId: scope.organization_id, actorId });
        fresh.push(actorId);
      } catch (error: unknown) {
        if (!(error instanceof CollaborationAuthorizationError)) throw error;
      }
    }
    return fresh;
  }

  /** Preset changes require the owner's fresh membership and, for a member grant, the target's. */
  async patchGrantPreset(input: PatchGrantPresetInput): Promise<GrantMutationResult> {
    const grant = await this.requireOwnerAndGrant(input);
    if (grant.audience.kind === "member") {
      await this.options.organizationPrecondition.require({ organizationId: grant.organizationId, actorId: grant.audience.actorId });
    }
    return this.options.grants.patchGrantPreset(input);
  }

  /** Revocation requires only the owner's fresh membership: ending a departed member's grant must stay possible. */
  async revokeGrant(input: RevokeGrantInput): Promise<GrantMutationResult> {
    await this.requireOwnerAndGrant(input);
    return this.options.grants.revokeGrant(input);
  }

  private async requireOwnerAndGrant(input: { scopeId: string; actorId: string; grantId: string }) {
    const grant = await this.options.grants.getGrant(input.grantId);
    if (!grant || grant.scopeId !== input.scopeId) throw new CollaborationAuthorizationError("not_found", "Grant not found");
    await this.options.organizationPrecondition.require({ organizationId: grant.organizationId, actorId: input.actorId });
    return grant;
  }

  /** Opening the share is the accept; the actor's fresh membership is re-checked inside the same request. */
  async acceptGrant(input: { grantId: string; actorId: string }): Promise<{ state: "active" }> {
    await this.requireGrantMembership(input);
    try {
      return await this.options.grants.acceptGrant({ ...input, membershipEvidenceEpoch: this.evidenceEpoch() });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  async declineGrant(input: { grantId: string; actorId: string }): Promise<{ state: "declined" }> {
    await this.requireGrantMembership(input);
    try {
      return await this.options.grants.declineGrant({ ...input, membershipEvidenceEpoch: this.evidenceEpoch() });
    } catch (error: unknown) {
      throw mapRepositoryError(error);
    }
  }

  private async requireGrantMembership(input: { grantId: string; actorId: string }): Promise<void> {
    const grant = await this.options.grants.getGrant(input.grantId);
    if (!grant) throw new CollaborationAuthorizationError("not_found", "Grant not found");
    await this.options.organizationPrecondition.require({ organizationId: grant.organizationId, actorId: input.actorId });
  }
}

/** The widest preset whose expansion is fully contained in the enforced set; the wire summary is never wider than enforcement. */
function presetContainedIn(actions: ReadonlySet<CollaborationCapabilityAction>): CollaborationPreset {
  const contributor = expandCollaborationPreset("contributor");
  return contributor.every((action) => actions.has(action)) ? "contributor" : "viewer";
}

function mapRepositoryError(error: unknown): unknown {
  if (error instanceof CollaborationRepositoryError) {
    if (error.code === "not_found") return new CollaborationAuthorizationError("not_found", "Grant not found");
    if (error.code === "expired") return new CollaborationAuthorizationError("not_found", "Grant not found");
  }
  return error;
}

export function newGrantId(): string {
  return randomUUID();
}
