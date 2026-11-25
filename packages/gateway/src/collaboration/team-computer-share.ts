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
  state: "active" | "stopping";
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
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stopping')),
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

/** Editors the policy names may open tabs: the people every new tab is shared with. */
export function policyLetsOpenTabs(policy: TeamComputerPolicy, actorId: string): boolean {
  return policy.grants.some((grant) => grant.preset === "contributor"
    && (grant.audience.kind === "organization" || grant.audience.actorId === actorId));
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

const SYNC_BATCH = TEAM_COMPUTER_MAX_TABS;

export class TeamComputerShareService {
  /** Share, stop, sync and open run one at a time, so a stop never races a pass that read the old policy. */
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private readonly openers = new Map<string, number[]>();
  private readonly now: () => Date;
  /** Where the next pass starts: every tab is visited in bounded batches, none is left out for good. */
  private cursor = 0;

  constructor(private readonly deps: TeamComputerShareDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queued >= 16) return Promise.reject(new TeamComputerShareError("unavailable"));
    this.queued += 1;
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => { this.queued -= 1; },
      (error: unknown) => {
        this.queued -= 1;
        console.warn("[team-computer] operation failed", error instanceof Error ? error.name : "UnknownError");
      },
    );
    return run;
  }

  /** The active policy; a computer being stopped has none. */
  async policy(): Promise<TeamComputerPolicy | null> {
    const row = await this.row();
    if (!row || row.state !== "active") return null;
    const grants = GrantsSchema.safeParse(row.grants);
    return grants.success ? { organizationId: row.organization_id, computerLabel: row.computer_label, grants: grants.data } : null;
  }

  /** Whether a stop started and has not finished, so the owner can retry it. */
  async stopping(): Promise<boolean> {
    return (await this.row())?.state === "stopping";
  }

  private row() {
    return this.deps.db.selectFrom("collaboration_team_computer_shares").selectAll()
      .where("owner_id", "=", this.deps.ownerId).executeTakeFirst();
  }

  async isComputerScope(scopeId: string): Promise<boolean> {
    return Boolean(await this.deps.db.selectFrom("collaboration_team_computer_scopes").select("scope_id")
      .where("scope_id", "=", scopeId).where("owner_id", "=", this.deps.ownerId).executeTakeFirst());
  }

  /** Records the policy (one per computer, idempotent upsert), then brings every tab in line with it. */
  share(policy: TeamComputerPolicy): Promise<number> {
    const grants = GrantsSchema.parse(policy.grants);
    return this.exclusive(async () => {
      const now = this.now().toISOString();
      await this.deps.db.insertInto("collaboration_team_computer_shares").values({
        owner_id: this.deps.ownerId, organization_id: policy.organizationId, computer_label: policy.computerLabel,
        grants: JSON.stringify(grants), revision: 1, state: "active", updated_at: now,
      }).onConflict((conflict) => conflict.column("owner_id").doUpdateSet({
        organization_id: policy.organizationId, computer_label: policy.computerLabel, grants: JSON.stringify(grants),
        revision: sql<number>`collaboration_team_computer_shares.revision + 1`, state: "active", updated_at: now,
      })).execute();
      return this.syncAll();
    });
  }

  /**
   * Stops sharing the computer. The policy is marked stopping first, so no
   * pass shares anything new; every grant on the computer's tabs then ends;
   * only then do the policy and the tab list go, together. A failure leaves
   * the stopping mark, and stopping again finishes the job.
   */
  stop(): Promise<void> {
    return this.exclusive(async () => {
      await this.deps.db.updateTable("collaboration_team_computer_shares")
        .set({ state: "stopping", updated_at: this.now().toISOString() })
        .where("owner_id", "=", this.deps.ownerId).execute();
      const scopes = await this.deps.db.selectFrom("collaboration_team_computer_scopes").select("scope_id")
        .where("owner_id", "=", this.deps.ownerId).execute();
      for (const { scope_id: scopeId } of scopes) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- revocations are ordered by scope revision.
        await this.reconcileGrants(scopeId, []);
      }
      await this.deps.db.transaction().execute(async (trx) => {
        await trx.deleteFrom("collaboration_team_computer_scopes").where("owner_id", "=", this.deps.ownerId).execute();
        await trx.deleteFrom("collaboration_team_computer_shares").where("owner_id", "=", this.deps.ownerId).execute();
      });
    });
  }

  /** One pass over the next batch of live tabs (a timer runs this). */
  sync(): Promise<number> {
    return this.exclusive(() => this.syncBatch());
  }

  /** An editor named by the policy opens a new tab; it is shared before it is returned. */
  async openTab(actorId: string): Promise<string> {
    this.admitOpen(actorId);
    return this.exclusive(async () => {
      const policy = await this.policy();
      if (!policy) throw new TeamComputerShareError("not_found");
      if (actorId !== this.deps.ownerId && !policyLetsOpenTabs(policy, actorId)) throw new TeamComputerShareError("forbidden");
      const terminalId = await this.deps.openTerminal();
      // The new tab is shared directly, not by a pass that listed the tabs before it existed.
      const scopeId = await this.syncTerminal(policy, terminalId);
      if (!scopeId) throw new TeamComputerShareError("unavailable");
      return scopeId;
    });
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

  /** Every tab, in batches; used after a policy change. */
  private async syncAll(): Promise<number> {
    const total = (await this.deps.listTerminals()).length;
    let shared = 0;
    for (let done = 0; done < total; done += SYNC_BATCH) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- batches are ordered and bounded.
      shared += await this.syncBatch();
    }
    return shared;
  }

  private async syncBatch(): Promise<number> {
    const policy = await this.policy();
    if (!policy) return 0;
    const terminals = await this.deps.listTerminals();
    if (terminals.length === 0) return 0;
    if (this.cursor >= terminals.length) this.cursor = 0;
    const batch = terminals.slice(this.cursor, this.cursor + SYNC_BATCH);
    this.cursor = this.cursor + SYNC_BATCH >= terminals.length ? 0 : this.cursor + SYNC_BATCH;
    let shared = 0;
    for (const terminalId of batch) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bounded and ordered: each tab's grants depend on its scope revision.
        if (await this.syncTerminal(policy, terminalId)) shared += 1;
      } catch (error: unknown) {
        // One tab that cannot be shared (it ended, or was replaced) never blocks the rest.
        console.warn("[team-computer] tab sync failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return shared;
  }

  private async syncTerminal(policy: TeamComputerPolicy, terminalId: string): Promise<string | null> {
    const preflight = await this.deps.terminals.preflight({ ownerId: this.deps.ownerId, organizationId: policy.organizationId, terminalId });
    let scopeId = preflight.existingScopeId;
    if (!scopeId) {
      if (!preflight.eligible || !preflight.confirmationToken) return null;
      scopeId = (await this.deps.terminals.shareTerminal({
        ownerId: this.deps.ownerId, organizationId: policy.organizationId, terminalId, clientRequestId: randomUUID(),
        payloadHash: SYNC_PAYLOAD_HASH, expectedResourceRevision: preflight.resourceRevision, confirmationToken: preflight.confirmationToken,
      })).id;
    }
    await this.deps.db.insertInto("collaboration_team_computer_scopes").values({ scope_id: scopeId, owner_id: this.deps.ownerId })
      .onConflict((conflict) => conflict.column("scope_id").doNothing()).execute();
    await writeTeamTerminalLabel(this.deps.db, { scopeId, computerLabel: policy.computerLabel, now: this.now() });
    await this.reconcileGrants(scopeId, policy.grants);
    const metadata = await this.deps.terminals.get(scopeId, terminalId);
    if (metadata && metadata.status === "active") {
      await this.deps.terminals.setContributorControl({
        scopeId, terminalId, incarnation: metadata.incarnation, ownerId: this.deps.ownerId,
        contributorControl: policy.grants.some((grant) => grant.preset === "contributor"),
      });
    }
    return scopeId;
  }

  /**
   * Makes a computer tab's live grants exactly the policy's: missing ones are
   * added, roles corrected, and grants the policy no longer names end. While a
   * computer is shared the policy is the one place access is decided, so a
   * per-terminal change is made through the policy (the owner's dialog does).
   */
  private async reconcileGrants(scopeId: string, wanted: readonly TeamComputerGrant[]): Promise<void> {
    let changed = false;
    const live = (await this.deps.grants.list(scopeId)).filter((grant) => grant.state === "active" || grant.state === "pending");
    for (const grant of live) {
      const match = wanted.find((entry) => sameAudience(entry.audience, grant.audience));
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each grant change needs the revision the last committed.
      const expectedRevision = await this.deps.scopeRevision(scopeId);
      if (!match) {
        await this.deps.grants.revoke({ scopeId, grantId: grant.grantId, actorId: this.deps.ownerId, clientRequestId: randomUUID(),
          expectedRevision, expectedGrantRevision: grant.grantRevision, payloadHash: SYNC_PAYLOAD_HASH });
        changed = true;
      } else if (match.preset !== grant.preset) {
        await this.deps.grants.patch({ scopeId, grantId: grant.grantId, actorId: this.deps.ownerId, clientRequestId: randomUUID(),
          expectedRevision, expectedGrantRevision: grant.grantRevision, payloadHash: SYNC_PAYLOAD_HASH, preset: match.preset });
        changed = true;
      }
    }
    for (const entry of wanted) {
      if (live.some((grant) => sameAudience(grant.audience, entry.audience))) continue;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each grant change needs the revision the last committed.
      const expectedRevision = await this.deps.scopeRevision(scopeId);
      await this.deps.grants.create({ scopeId, actorId: this.deps.ownerId, clientRequestId: randomUUID(), expectedRevision,
        payloadHash: SYNC_PAYLOAD_HASH, audience: entry.audience, preset: entry.preset });
      changed = true;
    }
    if (changed) await this.deps.committed(scopeId);
  }
}
