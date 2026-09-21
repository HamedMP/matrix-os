import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { lockLegacyDirectoryIngestion } from "./legacy-ingestion-lock.js";
import { inventoryPlatformPersonToPersonRecords } from "./person-to-person-inventory.js";
import type { CollaborationCutoverJournalTable, CollaborationPlatformDatabase } from "./database.js";

export type CutoverPhase = "pending" | "inventoried" | "fenced" | "drained" | "staged" | "verified" | "active" | "blocked";

export interface CutoverCounts {
  scopes: number;
  grants: number;
  invitations: number;
}

export interface CutoverHome {
  inventory(input: CutoverHomeRequest): Promise<{
    scopeId: string; organizationId: string; authorityGeneration: number;
    counts: CutoverCounts; idsDigest: string; ceilingDigest: string;
    backupInventoryRef: string; nonOrganizationRecords: number;
  }>;
  freeze(input: CutoverHomeRequest): Promise<{ fenceEpoch: number; fenceDigest: string }>;
  drain(input: CutoverHomeRequest): Promise<{ remainingRuns: number; interruptedRuns: number }>;
  stage(input: CutoverHomeRequest): Promise<{ counts: CutoverCounts; idsDigest: string; ceilingDigest: string }>;
  verify(input: CutoverHomeRequest): Promise<{ counts: CutoverCounts; idsDigest: string; ceilingDigest: string; nonOrganizationRecords: number }>;
  activate(input: CutoverHomeRequest): Promise<{ authorityGeneration: number }>;
  rollbackCompatible(input: CutoverHomeRequest): Promise<{ authorityGeneration: number }>;
  disable(input: CutoverHomeRequest): Promise<{ fenced: true }>;
}

export interface CutoverHomeRequest {
  scopeId: string;
  ownerId: string;
  runtimeId: string;
  organizationId: string;
  expectedSourceGeneration: number;
  targetGeneration: number;
  idempotencyKey: string;
}

export interface CutoverJournal {
  scopeId: string;
  phase: CutoverPhase;
  resumePhase: CutoverPhase | null;
  blockReason: string | null;
  counts: CutoverCounts | null;
  idsDigest: string | null;
  ceilingDigest: string | null;
  backupRef: string;
  rollbackMode: "compatible_direct" | null;
}

type JournalRow = Selectable<CollaborationCutoverJournalTable>;
const DIGEST = /^[a-f0-9]{64}$/;
const OPAQUE_REF = /^[A-Za-z0-9._:-]{1,256}$/;

function validCounts(value: CutoverCounts): boolean {
  return [value.scopes, value.grants, value.invitations].every((count) =>
    Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000);
}

function sameSnapshot(
  expected: { counts: CutoverCounts; idsDigest: string; ceilingDigest: string },
  actual: { counts: CutoverCounts; idsDigest: string; ceilingDigest: string },
): boolean {
  return validCounts(actual.counts)
    && DIGEST.test(actual.idsDigest) && DIGEST.test(actual.ceilingDigest)
    && actual.idsDigest === expected.idsDigest
    && actual.ceilingDigest === expected.ceilingDigest
    && actual.counts.scopes === expected.counts.scopes
    && actual.counts.grants === expected.counts.grants
    && actual.counts.invitations === expected.counts.invitations;
}

function publicJournal(row: JournalRow): CutoverJournal {
  return {
    scopeId: row.scope_id,
    phase: row.phase,
    resumePhase: row.resume_phase,
    blockReason: row.block_reason,
    counts: row.counts,
    idsDigest: row.ids_digest,
    ceilingDigest: row.ceiling_digest,
    backupRef: row.backup_ref,
    rollbackMode: row.rollback_mode,
  };
}

/** A cutover scope issues tickets only from its activated direct generation. */
export async function cutoverTicketAdmission(
  db: Kysely<CollaborationPlatformDatabase>, scopeId: string,
): Promise<boolean> {
  const row = await db.selectFrom("collaboration_directory as directory")
    .leftJoin("collaboration_cutover_journal as journal", "journal.scope_id", "directory.scope_id")
    .select([
      "journal.phase", "journal.target_generation",
      "directory.authority_generation", "directory.direct_native",
    ])
    .where("directory.scope_id", "=", scopeId).executeTakeFirst();
  // Absence never admits: an unknown scope is denied like any other.
  if (!row) return false;
  // A scope created after the cutover migration is direct from birth and never
  // receives a migration journal. Every row that already existed was marked
  // legacy by that migration, so it stays denied until its own journal
  // activates rather than being admitted at its legacy generation.
  if (row.phase === null) return row.direct_native === true;
  return row.phase === "active"
    && Number(row.authority_generation) === Number(row.target_generation);
}

/** Raised inside the activation transaction; the scope blocks instead of activating. */
class LegacyDispositionRequiredError extends Error {
  constructor() {
    super("An undispositioned person-to-person record blocks activation");
    this.name = "LegacyDispositionRequiredError";
  }
}

export class PlatformCollaborationCutover {
  constructor(private readonly options: {
    db: Kysely<CollaborationPlatformDatabase>;
    resolveHome(input: { scopeId: string; runtimeId: string; ownerId: string }): Promise<
      { status: "ready"; home: CutoverHome } | { status: "offline" | "ambiguous" }
    >;
    /** Fresh, authenticated proof of the exact installed owner's compatible direct build. */
    verifyCompatibleDirectBuild?(input: { scopeId: string; runtimeId: string; ownerId: string; targetGeneration: number }): Promise<boolean>;
  }) {}

  async run(scopeId: string, input: { backupRef: string }): Promise<CutoverJournal> {
    if (!OPAQUE_REF.test(input.backupRef)) throw new Error("A restricted backup reference is required");
    await this.createJournal(scopeId, input.backupRef);
    return this.advance(scopeId);
  }

  async resume(scopeId: string): Promise<CutoverJournal> {
    const row = await this.requireRow(scopeId);
    if (row.phase !== "blocked" || !row.resume_phase || row.block_reason === "disabled_for_recovery") {
      return publicJournal(row);
    }
    await this.options.db.updateTable("collaboration_cutover_journal")
      .set({ phase: row.resume_phase, resume_phase: null, block_reason: null, updated_at: new Date() })
      .where("scope_id", "=", scopeId).where("phase", "=", "blocked")
      .execute();
    return this.advance(scopeId);
  }

  async rollback(scopeId: string, mode: string, proof?: { compatibleDirectBuild: true }): Promise<CutoverJournal> {
    if (mode !== "compatible_direct" && mode !== "disable") throw new Error("Legacy collaboration rollback is forbidden");
    const row = await this.requireRow(scopeId);
    if (mode === "compatible_direct") {
      if (proof?.compatibleDirectBuild !== true) throw new Error("A compatible direct build must be verified before rollback");
      if (row.phase !== "active") throw new Error("Compatible rollback requires an active direct generation");
      let verified = false;
      try {
        verified = await this.options.verifyCompatibleDirectBuild?.({
          scopeId, runtimeId: row.runtime_id, ownerId: row.owner_id,
          targetGeneration: Number(row.target_generation),
        }) === true;
      } catch (error: unknown) {
        console.warn("[collaboration-cutover] compatible build verification unavailable", error instanceof Error ? error.name : "UnknownError");
      }
      if (!verified) throw new Error("A compatible direct build must be verified before rollback");
      const resolution = await this.readyHome(row);
      if (resolution.status !== "ready") return this.block(row, resolution.status, "verified");
      try {
        const result = await resolution.home.rollbackCompatible(this.homeRequest(row));
        if (result.authorityGeneration !== Number(row.target_generation)) return this.block(row, "rollback_generation_mismatch", "verified");
      } catch (error: unknown) {
        console.warn("[collaboration-cutover] compatible rollback unavailable", error instanceof Error ? error.name : "UnknownError");
        return this.block(row, "rollback_unavailable", "verified");
      }
      await this.options.db.updateTable("collaboration_cutover_journal")
        .set({ rollback_mode: "compatible_direct", updated_at: new Date() })
        .where("scope_id", "=", scopeId).where("phase", "=", "active").execute();
      return publicJournal(await this.requireRow(scopeId));
    }
    // Disable the platform first so no new ticket can be admitted while the home fence is in flight.
    const disabled = await this.block(row, "disabled_for_recovery", null);
    const resolution = await this.readyHome(row);
    if (resolution.status === "ready") {
      try {
        await resolution.home.disable(this.homeRequest(row));
      } catch (error: unknown) {
        console.warn("[collaboration-cutover] home disable pending reconciliation", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return disabled;
  }

  async terminateLegacy(input: { scopeId: string; noticeRef: string; backupRef: string; homeReceipt: string }): Promise<void> {
    if (![input.noticeRef, input.backupRef, input.homeReceipt].every((value) => OPAQUE_REF.test(value))) {
      throw new Error("Legacy termination requires a notice, backup and home receipt");
    }
    await this.options.db.transaction().execute(async (trx) => {
      const previous = await trx.selectFrom("collaboration_cutover_dispositions").selectAll()
        .where("scope_id", "=", input.scopeId).executeTakeFirst();
      if (previous) {
        if (previous.notice_ref !== input.noticeRef || previous.backup_ref !== input.backupRef || previous.home_receipt !== input.homeReceipt) {
          throw new Error("Legacy disposition receipt changed");
        }
        return;
      }
      const directory = await trx.selectFrom("collaboration_directory").selectAll()
        .where("scope_id", "=", input.scopeId).forUpdate().executeTakeFirst();
      if (!directory || directory.organization_id !== null) throw new Error("Only a legacy person-to-person scope can be terminated");
      const count = await trx.selectFrom("collaboration_user_index")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("scope_id", "=", input.scopeId).executeTakeFirstOrThrow();
      await trx.insertInto("collaboration_cutover_dispositions").values({
        scope_id: input.scopeId, action: "terminated", owner_id: directory.owner_id,
        runtime_id: directory.runtime_id, notice_ref: input.noticeRef, backup_ref: input.backupRef,
        home_receipt: input.homeReceipt, index_rows: Number(count.count), decided_at: new Date(),
      }).execute();
      await trx.deleteFrom("collaboration_directory").where("scope_id", "=", input.scopeId).execute();
    });
  }

  private async createJournal(scopeId: string, backupRef: string): Promise<void> {
    await this.options.db.transaction().execute(async (trx) => {
      const directory = await trx.selectFrom("collaboration_directory").selectAll()
        .where("scope_id", "=", scopeId).forUpdate().executeTakeFirst();
      if (!directory || !directory.organization_id) throw new Error("Organization scope is required for direct cutover");
      const existing = await trx.selectFrom("collaboration_cutover_journal").selectAll()
        .where("scope_id", "=", scopeId).executeTakeFirst();
      if (existing) {
        if (existing.backup_ref !== backupRef) throw new Error("Cutover backup reference changed");
        return;
      }
      await trx.insertInto("collaboration_cutover_journal").values({
        scope_id: scopeId, cutover_id: randomUUID(), owner_id: directory.owner_id,
        runtime_id: directory.runtime_id, organization_id: directory.organization_id,
        source_generation: Number(directory.authority_generation),
        target_generation: Number(directory.authority_generation) + 1,
        source_metadata_revision: Number(directory.metadata_revision),
        phase: "pending", resume_phase: null, block_reason: null,
        backup_ref: backupRef, backup_inventory_ref: null, counts: null,
        ids_digest: null, ceiling_digest: null, fence_epoch: null, fence_digest: null,
        interrupted_runs: null, rollback_mode: null, updated_at: new Date(),
      }).onConflict((conflict) => conflict.column("scope_id").doNothing()).execute();
    });
  }

  private async advance(scopeId: string): Promise<CutoverJournal> {
    for (let step = 0; step < 8; step += 1) {
      const row = await this.requireRow(scopeId);
      if (row.phase === "active" || row.phase === "blocked") return publicJournal(row);
      if (row.phase === "pending" || row.phase === "verified") {
        const legacy = await inventoryPlatformPersonToPersonRecords(this.options.db);
        if (legacy.total !== 0) return this.block(row, "legacy_disposition_required", row.phase);
      }
      const resolution = await this.readyHome(row);
      if (resolution.status !== "ready") return this.block(row, resolution.status, row.phase);
      const home = resolution.home;
      const request = this.homeRequest(row);
      try {
        if (row.phase === "pending") {
          const snapshot = await home.inventory(request);
          if (snapshot.nonOrganizationRecords !== 0) return this.block(row, "legacy_disposition_required", "pending");
          if (snapshot.scopeId !== scopeId || snapshot.organizationId !== row.organization_id
            || snapshot.authorityGeneration !== Number(row.source_generation)
            || !validCounts(snapshot.counts) || !DIGEST.test(snapshot.idsDigest)
            || !DIGEST.test(snapshot.ceilingDigest) || !OPAQUE_REF.test(snapshot.backupInventoryRef)) {
            return this.block(row, "inventory_mismatch", "pending");
          }
          await this.transition(row, "inventoried", {
            counts: snapshot.counts, ids_digest: snapshot.idsDigest,
            ceiling_digest: snapshot.ceilingDigest, backup_inventory_ref: snapshot.backupInventoryRef,
          });
        } else if (row.phase === "inventoried") {
          const fence = await home.freeze(request);
          if (!Number.isSafeInteger(fence.fenceEpoch) || fence.fenceEpoch < 1 || !DIGEST.test(fence.fenceDigest)) {
            return this.block(row, "fence_mismatch", "inventoried");
          }
          await this.transition(row, "fenced", { fence_epoch: fence.fenceEpoch, fence_digest: fence.fenceDigest });
        } else if (row.phase === "fenced") {
          const drain = await home.drain(request);
          if (drain.remainingRuns !== 0 || !Number.isSafeInteger(drain.interruptedRuns) || drain.interruptedRuns < 0) {
            return this.block(row, "drain_incomplete", "fenced");
          }
          await this.transition(row, "drained", { interrupted_runs: drain.interruptedRuns });
        } else if (row.phase === "drained") {
          const staged = await home.stage(request);
          if (!sameSnapshot(this.snapshot(row), staged)) return this.block(row, "shadow_mismatch", "drained");
          await this.transition(row, "staged");
        } else if (row.phase === "staged") {
          const verified = await home.verify(request);
          if (verified.nonOrganizationRecords !== 0 || !sameSnapshot(this.snapshot(row), verified)) {
            return this.block(row, "verification_mismatch", "staged");
          }
          await this.transition(row, "verified");
        } else if (row.phase === "verified") {
          const activated = await home.activate(request);
          if (activated.authorityGeneration !== Number(row.target_generation)) {
            return this.block(row, "activation_generation_mismatch", "verified");
          }
          try {
            await this.activateDirectory(row);
          } catch (error: unknown) {
            if (error instanceof LegacyDispositionRequiredError) {
              return this.block(row, "legacy_disposition_required", "verified");
            }
            console.warn("[collaboration-cutover] directory activation needs recovery", error instanceof Error ? error.name : "UnknownError");
            return this.block(row, "directory_generation_conflict", "verified");
          }
        }
      } catch (error: unknown) {
        console.warn("[collaboration-cutover] home phase unavailable", error instanceof Error ? error.name : "UnknownError");
        return this.block(row, "home_unavailable", row.phase);
      }
    }
    throw new Error("Cutover did not reach a stable state");
  }

  private snapshot(row: JournalRow): { counts: CutoverCounts; idsDigest: string; ceilingDigest: string } {
    if (!row.counts || !row.ids_digest || !row.ceiling_digest) throw new Error("Cutover snapshot is missing");
    return { counts: row.counts, idsDigest: row.ids_digest, ceilingDigest: row.ceiling_digest };
  }

  private homeRequest(row: JournalRow): CutoverHomeRequest {
    return {
      scopeId: row.scope_id, ownerId: row.owner_id, runtimeId: row.runtime_id,
      organizationId: row.organization_id,
      expectedSourceGeneration: Number(row.source_generation),
      targetGeneration: Number(row.target_generation), idempotencyKey: row.cutover_id,
    };
  }

  private async readyHome(row: JournalRow): Promise<Awaited<ReturnType<typeof this.options.resolveHome>>> {
    try {
      return await this.options.resolveHome({ scopeId: row.scope_id, runtimeId: row.runtime_id, ownerId: row.owner_id });
    } catch (error: unknown) {
      console.warn("[collaboration-cutover] home resolution unavailable", error instanceof Error ? error.name : "UnknownError");
      return { status: "offline" };
    }
  }

  private async requireRow(scopeId: string): Promise<JournalRow> {
    const row = await this.options.db.selectFrom("collaboration_cutover_journal").selectAll()
      .where("scope_id", "=", scopeId).executeTakeFirst();
    if (!row) throw new Error("Cutover journal not found");
    return row;
  }

  private async transition(row: JournalRow, next: CutoverPhase, values: Partial<JournalRow> = {}): Promise<void> {
    await this.options.db.updateTable("collaboration_cutover_journal")
      .set({ ...values, phase: next, resume_phase: null, block_reason: null, updated_at: new Date() })
      .where("scope_id", "=", row.scope_id).where("phase", "=", row.phase).execute();
  }

  private async block(row: JournalRow, reason: string, resumePhase: CutoverPhase | null): Promise<CutoverJournal> {
    await this.options.db.updateTable("collaboration_cutover_journal")
      .set({ phase: "blocked", resume_phase: resumePhase, block_reason: reason, updated_at: new Date() })
      .where("scope_id", "=", row.scope_id).where("phase", "=", row.phase).execute();
    return publicJournal(await this.requireRow(row.scope_id));
  }

  private async activateDirectory(row: JournalRow): Promise<void> {
    await this.options.db.transaction().execute(async (trx) => {
      // The global legacy check in `advance` is a pre-read: under READ COMMITTED
      // a legacy directory event can commit between it and this write. Take the
      // shared ingestion lock and re-count inside the transaction that activates
      // the generation, so no scope can go active past an undispositioned
      // person-to-person record.
      await lockLegacyDirectoryIngestion(trx);
      const legacy = await inventoryPlatformPersonToPersonRecords(trx);
      if (legacy.total !== 0) throw new LegacyDispositionRequiredError();
      const updated = await trx.updateTable("collaboration_directory")
        .set({ authority_generation: Number(row.target_generation),
          metadata_revision: Number(row.source_metadata_revision) + 1,
          last_event_id: randomUUID(), updated_at: new Date() })
        .where("scope_id", "=", row.scope_id)
        .where("runtime_id", "=", row.runtime_id)
        .where("owner_id", "=", row.owner_id)
        .where("organization_id", "=", row.organization_id)
        .where("authority_generation", "=", Number(row.source_generation))
        .where("metadata_revision", "=", Number(row.source_metadata_revision))
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new Error("Directory generation changed");
      await trx.updateTable("collaboration_user_index")
        .set({ locator_generation: Number(row.target_generation), updated_at: new Date() })
        .where("scope_id", "=", row.scope_id).execute();
      const journal = await trx.updateTable("collaboration_cutover_journal")
        .set({ phase: "active", resume_phase: null, block_reason: null, updated_at: new Date() })
        .where("scope_id", "=", row.scope_id).where("phase", "=", "verified")
        .executeTakeFirst();
      if (journal.numUpdatedRows !== 1n) throw new Error("Cutover phase changed");
    });
  }
}
