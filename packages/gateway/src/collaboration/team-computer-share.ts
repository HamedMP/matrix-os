/**
 * Spec 2710 layer 6: share a whole computer. The owner records once who the
 * computer is shared with; every live terminal tab on it, now and later, is
 * a team terminal with exactly those grants, and editors may open new tabs.
 * Each tab stays its own terminal scope, so roles, revocation, presence and
 * caps are the per-terminal ones; this service only keeps them in step.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  TEAM_COMPUTER_MAX_TABS,
  TeamComputerGrantSchema,
  type CollaborationAudience,
  type CollaborationPreset,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import { writeTeamTerminalLabel } from "./team-terminal-labels.js";

export const TEAM_COMPUTER_MIGRATION_VERSION = 19;
const GrantsSchema = z.array(TeamComputerGrantSchema).max(32);
const SYNC_PAYLOAD_HASH = createHash("sha256").update("matrix-team-computer-sync-v1").digest("hex");
const MAX_OPENED_PER_MINUTE = 10;
const MAX_TRACKED_OPENERS = 256;

export interface CollaborationTeamComputerSharesTable {
  owner_id: string;
  organization_id: string;
  computer_label: string;
  grants: unknown;
  revision: number;
  updated_at: Date | string;
}

export interface CollaborationTeamComputerScopesTable {
  scope_id: string;
  owner_id: string;
}

export async function migrateTeamComputerSharesV19(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_team_computer_shares (
      owner_id TEXT PRIMARY KEY CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      organization_id TEXT NOT NULL CHECK (char_length(organization_id) BETWEEN 5 AND 128),
      computer_label TEXT NOT NULL CHECK (char_length(computer_label) BETWEEN 1 AND 64),
      grants JSONB NOT NULL,
      revision BIGINT NOT NULL CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL
    )
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_team_computer_scopes (
      scope_id UUID PRIMARY KEY REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128)
    )
  `.execute(trx);
  await sql`INSERT INTO collaboration_schema_migrations (version)
    VALUES (${TEAM_COMPUTER_MIGRATION_VERSION}) ON CONFLICT (version) DO NOTHING`.execute(trx);
}

export type TeamComputerGrant = { audience: CollaborationAudience; preset: CollaborationPreset };
export interface TeamComputerPolicy {
  organizationId: string;
  computerLabel: string;
  grants: TeamComputerGrant[];
}

export class TeamComputerShareError extends Error {
  constructor(public readonly code: "not_found" | "forbidden" | "rate_limited" | "unavailable") {
    super("Shared computer is unavailable");
    this.name = "TeamComputerShareError";
  }
}

interface GrantRecordLike { grantId: string; audience: CollaborationAudience; preset: CollaborationPreset; state: string; grantRevision: number }

export interface TeamComputerShareDependencies {
  db: Kysely<OwnerCollaborationDatabase>;
  ownerId: string;
  /** Live owner tabs on this computer, canonical `workspaceId:tabId`. */
  listTerminals(): Promise<string[]>;
  /** Opens a new tab in the computer's main workspace and returns its terminal id. */
  openTerminal(): Promise<string>;
  terminals: {
    preflight(input: { ownerId: string; organizationId: string; terminalId: string }): Promise<{
      eligible: boolean; resourceRevision: number; confirmationToken?: string; existingScopeId?: string;
    }>;
    shareTerminal(input: {
      ownerId: string; organizationId: string; terminalId: string; clientRequestId: string; payloadHash: string;
      expectedResourceRevision: number; confirmationToken: string;
    }): Promise<{ id: string }>;
    get(scopeId: string, terminalId: string): Promise<{ incarnation: string; status: string } | null>;
    setContributorControl(input: { scopeId: string; terminalId: string; incarnation: string; ownerId: string; contributorControl: boolean }): Promise<void>;
  };
  grants: {
    list(scopeId: string): Promise<GrantRecordLike[]>;
    create(input: { scopeId: string; actorId: string; clientRequestId: string; expectedRevision: number; payloadHash: string; audience: CollaborationAudience; preset: CollaborationPreset }): Promise<unknown>;
    patch(input: { scopeId: string; grantId: string; actorId: string; clientRequestId: string; expectedRevision: number; expectedGrantRevision: number; payloadHash: string; preset: CollaborationPreset }): Promise<unknown>;
    revoke(input: { scopeId: string; grantId: string; actorId: string; clientRequestId: string; expectedRevision: number; expectedGrantRevision: number; payloadHash: string }): Promise<unknown>;
  };
  scopeRevision(scopeId: string): Promise<number>;
  /** After a committed grant change: broadcast and re-check live sockets. */
  committed(scopeId: string): Promise<void>;
  now?: () => Date;
}

const sameAudience = (left: CollaborationAudience, right: CollaborationAudience) =>
  left.kind === right.kind && (left.kind === "organization" || (right.kind === "member" && left.actorId === right.actorId));

export class TeamComputerShareService {
  private syncing: Promise<number> | null = null;
  private readonly openers = new Map<string, number[]>();
  private readonly now: () => Date;

  constructor(private readonly deps: TeamComputerShareDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async policy(): Promise<TeamComputerPolicy | null> {
    const row = await this.deps.db.selectFrom("collaboration_team_computer_shares").selectAll()
      .where("owner_id", "=", this.deps.ownerId).executeTakeFirst();
    if (!row) return null;
    const grants = GrantsSchema.safeParse(row.grants);
    return grants.success ? { organizationId: row.organization_id, computerLabel: row.computer_label, grants: grants.data } : null;
  }

  async isComputerScope(scopeId: string): Promise<boolean> {
    return Boolean(await this.deps.db.selectFrom("collaboration_team_computer_scopes").select("scope_id")
      .where("scope_id", "=", scopeId).where("owner_id", "=", this.deps.ownerId).executeTakeFirst());
  }

  /** Records the policy (one per computer, idempotent upsert), then shares every tab with it. */
  async share(policy: TeamComputerPolicy): Promise<number> {
    const grants = GrantsSchema.parse(policy.grants);
    const now = this.now().toISOString();
    await this.deps.db.insertInto("collaboration_team_computer_shares").values({
      owner_id: this.deps.ownerId, organization_id: policy.organizationId, computer_label: policy.computerLabel,
      grants: JSON.stringify(grants), revision: 1, updated_at: now,
    }).onConflict((conflict) => conflict.column("owner_id").doUpdateSet({
      organization_id: policy.organizationId, computer_label: policy.computerLabel, grants: JSON.stringify(grants),
      revision: sql<number>`collaboration_team_computer_shares.revision + 1`, updated_at: now,
    })).execute();
    return this.sync();
  }

  /** Stops sharing the computer: every grant on its tabs ends, then the policy and the list go. */
  async stop(): Promise<void> {
    const scopes = await this.deps.db.selectFrom("collaboration_team_computer_scopes").select("scope_id")
      .where("owner_id", "=", this.deps.ownerId).execute();
    // The policy goes first so a concurrent sync shares nothing new while grants end.
    await this.deps.db.deleteFrom("collaboration_team_computer_shares").where("owner_id", "=", this.deps.ownerId).execute();
    for (const { scope_id: scopeId } of scopes) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- revocations are ordered by scope revision.
      for (const grant of (await this.deps.grants.list(scopeId)).filter((entry) => entry.state === "active" || entry.state === "pending")) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each revocation needs the revision the last committed.
        await this.deps.grants.revoke({
          scopeId, grantId: grant.grantId, actorId: this.deps.ownerId, clientRequestId: randomUUID(),
          expectedRevision: await this.deps.scopeRevision(scopeId), expectedGrantRevision: grant.grantRevision, payloadHash: SYNC_PAYLOAD_HASH,
        });
      }
      await this.deps.committed(scopeId);
    }
    await this.deps.db.deleteFrom("collaboration_team_computer_scopes").where("owner_id", "=", this.deps.ownerId).execute();
  }

  /** Brings every live tab in line with the policy; one pass at a time, at most 64 tabs. */
  sync(): Promise<number> {
    this.syncing ??= this.syncNow().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  /** An editor of a shared computer opens a new tab there; it is shared before it is returned. */
  async openTab(actorId: string): Promise<string> {
    this.admitOpen(actorId);
    const policy = await this.policy();
    if (!policy) throw new TeamComputerShareError("not_found");
    const terminalId = await this.deps.openTerminal();
    await this.sync();
    const preflight = await this.deps.terminals.preflight({ ownerId: this.deps.ownerId, organizationId: policy.organizationId, terminalId });
    if (!preflight.existingScopeId) throw new TeamComputerShareError("unavailable");
    return preflight.existingScopeId;
  }

  private admitOpen(actorId: string): void {
    const now = this.now().getTime();
    const recent = (this.openers.get(actorId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= MAX_OPENED_PER_MINUTE) throw new TeamComputerShareError("rate_limited");
    this.openers.delete(actorId);
    while (this.openers.size >= MAX_TRACKED_OPENERS) {
      const oldest = this.openers.keys().next().value;
      if (oldest === undefined) break;
      this.openers.delete(oldest);
    }
    this.openers.set(actorId, [...recent, now]);
  }

  private async syncNow(): Promise<number> {
    const policy = await this.policy();
    if (!policy) return 0;
    const terminals = (await this.deps.listTerminals()).slice(0, TEAM_COMPUTER_MAX_TABS);
    let shared = 0;
    for (const terminalId of terminals) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bounded (64 tabs) and ordered: each tab's grants depend on its scope revision.
        await this.syncTerminal(policy, terminalId);
        shared += 1;
      } catch (error: unknown) {
        // One tab that cannot be shared (it ended, or was replaced) never blocks the rest.
        console.warn("[team-computer] tab sync failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return shared;
  }

  private async syncTerminal(policy: TeamComputerPolicy, terminalId: string): Promise<void> {
    const preflight = await this.deps.terminals.preflight({ ownerId: this.deps.ownerId, organizationId: policy.organizationId, terminalId });
    let scopeId = preflight.existingScopeId;
    if (!scopeId) {
      if (!preflight.eligible || !preflight.confirmationToken) return;
      scopeId = (await this.deps.terminals.shareTerminal({
        ownerId: this.deps.ownerId, organizationId: policy.organizationId, terminalId, clientRequestId: randomUUID(),
        payloadHash: SYNC_PAYLOAD_HASH, expectedResourceRevision: preflight.resourceRevision, confirmationToken: preflight.confirmationToken,
      })).id;
    }
    await this.deps.db.insertInto("collaboration_team_computer_scopes").values({ scope_id: scopeId, owner_id: this.deps.ownerId })
      .onConflict((conflict) => conflict.column("scope_id").doNothing()).execute();
    await writeTeamTerminalLabel(this.deps.db, { scopeId, computerLabel: policy.computerLabel, now: this.now() });
    let changed = false;
    const existing = (await this.deps.grants.list(scopeId)).filter((grant) => grant.state === "active" || grant.state === "pending");
    for (const wanted of policy.grants) {
      const match = existing.find((grant) => sameAudience(grant.audience, wanted.audience));
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each grant change needs the revision the last committed.
      const expectedRevision = await this.deps.scopeRevision(scopeId);
      if (!match) {
        await this.deps.grants.create({ scopeId, actorId: this.deps.ownerId, clientRequestId: randomUUID(), expectedRevision,
          payloadHash: SYNC_PAYLOAD_HASH, audience: wanted.audience, preset: wanted.preset });
        changed = true;
      } else if (match.preset !== wanted.preset) {
        await this.deps.grants.patch({ scopeId, grantId: match.grantId, actorId: this.deps.ownerId, clientRequestId: randomUUID(),
          expectedRevision, expectedGrantRevision: match.grantRevision, payloadHash: SYNC_PAYLOAD_HASH, preset: wanted.preset });
        changed = true;
      }
    }
    const metadata = await this.deps.terminals.get(scopeId, terminalId);
    if (metadata && metadata.status === "active") {
      await this.deps.terminals.setContributorControl({
        scopeId, terminalId, incarnation: metadata.incarnation, ownerId: this.deps.ownerId,
        contributorControl: policy.grants.some((grant) => grant.preset === "contributor"),
      });
    }
    if (changed) await this.deps.committed(scopeId);
  }
}
