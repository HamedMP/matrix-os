/** S04: row-to-record mappers for whole-project preset grants and per-member activations. */
import type { Selectable } from "kysely";
import type { CollaborationAudience, CollaborationPreset } from "@matrix-os/contracts";
import type { CollaborationGrantActivationsTable, CollaborationGrantsTable } from "./database.js";
import { toIso } from "./repository-shared.js";

export type GrantRow = Selectable<CollaborationGrantsTable>;
export type ActivationRow = Selectable<CollaborationGrantActivationsTable>;

export interface GrantRecord {
  grantId: string;
  scopeId: string;
  organizationId: string;
  audience: CollaborationAudience;
  preset: CollaborationPreset;
  state: GrantRow["state"];
  policyVersion: string;
  legacyCeiling: "editor" | "viewer" | null;
  expiresAt?: string;
  grantRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActivationRecord {
  grantId: string;
  actorId: string;
  state: "active" | "declined";
  decidedAt: string;
  membershipEvidenceEpoch: string;
}

export function toGrantRecord(row: GrantRow): GrantRecord {
  return {
    grantId: row.id,
    scopeId: row.scope_id,
    organizationId: row.organization_id,
    audience: row.audience_kind === "organization"
      ? { kind: "organization" }
      : { kind: "member", actorId: row.audience_actor_id ?? "" },
    preset: row.preset,
    state: row.state,
    policyVersion: row.policy_version,
    legacyCeiling: row.legacy_ceiling,
    ...(row.expires_at === null ? {} : { expiresAt: toIso(row.expires_at) }),
    grantRevision: Number(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function toActivationRecord(row: ActivationRow): ActivationRecord {
  return {
    grantId: row.grant_id,
    actorId: row.actor_id,
    state: row.state,
    decidedAt: toIso(row.decided_at),
    membershipEvidenceEpoch: String(row.membership_evidence_epoch),
  };
}
