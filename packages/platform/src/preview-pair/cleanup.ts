import { z } from "zod/v4";
import { sql } from "kysely";
import type { PlatformDB } from "../db.js";
import { PreviewPairConflictError } from "./repository.js";
import { withPreviewPairClaim, type PreviewPairClaim } from "./lifecycle.js";

export interface PreviewPairCleanupMember {
  pairId: string; generation: number; machineId: string; jobId: string;
  handle: string; actorId: string; providerServerId: number | null;
}
export interface PreviewPairCleanupAdapters {
  /** Trusted, idempotent transport: exact machine binding, never arbitrary SSH input. */
  retire(member: PreviewPairCleanupMember, claim: PreviewPairClaim): Promise<void>;
  /** Independently inspect exact provider ID, labels AND unsettled creation actions. */
  proveAbsent(member: PreviewPairCleanupMember, claim: PreviewPairClaim): Promise<unknown>;
}
const Absence = z.strictObject({ machineId: z.uuid(), providerServerId: z.number().int().positive().nullable(),
  exactServerAbsent: z.literal(true), labeledServerIds: z.array(z.number().int().positive()).length(0),
  creationSettled: z.literal(true), observedAt: z.iso.datetime({ offset: true }) });

/** External callbacks own network deadlines; ledger transactions never cross a network call. */
export async function cleanupPreviewPair(db: PlatformDB, claim: PreviewPairClaim,
  adapters: PreviewPairCleanupAdapters, now: () => number): Promise<void> {
  const members = await withPreviewPairClaim(db, claim, now(), async trx => {
    const pair = await trx.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", claim.pairId).executeTakeFirstOrThrow();
    if (pair.state !== "cleanup_pending" && pair.state !== "updating") throw new PreviewPairConflictError();
    const rows = await trx.executor.selectFrom("preview_pair_members as member").innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
      .select(["member.pair_id", "member.generation", "member.machine_id", "member.job_id", "member.handle", "member.actor_id",
        "member.provider_absent_at", "machine.hetzner_server_id", "machine.clerk_user_id", "machine.runtime_slot", "machine.provisioning_class"])
      .where("member.pair_id", "=", claim.pairId).where("member.provider_absent_at", "is", null)
      .orderBy("member.generation").orderBy("member.role").execute();
    if (rows.length > 2) throw new PreviewPairConflictError();
    // Retire the whole pair atomically before any unavailable external system can
    // delay the other member's access revocation or physical deletion attempt.
    for (const row of rows) {
      if (row.generation > claim.generation || row.clerk_user_id !== row.actor_id || row.runtime_slot !== row.handle
        || row.provisioning_class !== "preview") throw new PreviewPairConflictError();
      await trx.executor.updateTable("user_machines").set({ status: "deleted", deleted_at: new Date(now()).toISOString(),
        runtime_token_epoch: sql`runtime_token_epoch + 1` }).where("machine_id", "=", row.machine_id)
        .where("clerk_user_id", "=", row.actor_id).where("handle", "=", row.handle)
        .where("runtime_slot", "=", row.handle).where("provisioning_class", "=", "preview").where("deleted_at", "is", null).execute();
      await trx.executor.updateTable("provisioning_jobs").set({ status: "failed", last_error_code: "pair_retired",
        encrypted_payload: null, updated_at: new Date(now()).toISOString() }).where("job_id", "=", row.job_id)
        .where("machine_id", "=", row.machine_id).where("status", "in", ["queued", "running"]).execute();
      await trx.executor.updateTable("preview_pair_members").set({ retired_at: new Date(now()).toISOString() })
        .where("machine_id", "=", row.machine_id).where("retired_at", "is", null).execute();
    }
    return rows;
  });
  try {
    const attempts = await Promise.allSettled(members.map(async row => {
      const member: PreviewPairCleanupMember = { pairId: row.pair_id, generation: row.generation,
        machineId: row.machine_id, jobId: row.job_id, handle: row.handle, actorId: row.actor_id,
        providerServerId: row.hetzner_server_id === null ? null : Number(row.hetzner_server_id) };
      await withPreviewPairClaim(db, claim, now(), async () => undefined);
      await adapters.retire(member, claim);
      await withPreviewPairClaim(db, claim, now(), async () => undefined);
      const parsed = Absence.safeParse(await adapters.proveAbsent(member, claim));
      const checkedAt = parsed.success ? Date.parse(parsed.data.observedAt) : Number.NaN;
      if (!parsed.success || parsed.data.machineId !== member.machineId || parsed.data.providerServerId !== member.providerServerId
        || now() - checkedAt > 60_000 || checkedAt > now() + 5_000) throw new Error("Preview absence is unconfirmed");
      await withPreviewPairClaim(db, claim, now(), async trx => {
        const job = await trx.executor.selectFrom("provisioning_jobs").select("lease_expires_at")
          .where("job_id", "=", member.jobId).where("machine_id", "=", member.machineId).executeTakeFirstOrThrow();
        if (job.lease_expires_at && Date.parse(job.lease_expires_at) > now()) throw new Error("Creation lease is unsettled");
        await trx.executor.updateTable("preview_pair_members").set({ provider_absent_at: new Date(now()).toISOString() })
          .where("machine_id", "=", member.machineId).where("provider_absent_at", "is", null).execute();
      });
    }));
    for (const attempt of attempts) if (attempt.status === "rejected") {
      if (attempt.reason instanceof PreviewPairConflictError) throw attempt.reason;
      throw new Error("Preview retirement remains pending");
    }
    await withPreviewPairClaim(db, claim, now(), async trx => {
      const remaining = await trx.executor.selectFrom("preview_pair_members").select("machine_id")
        .where("pair_id", "=", claim.pairId).where("provider_absent_at", "is", null).executeTakeFirst();
      if (remaining) throw new PreviewPairConflictError();
      const pair = await trx.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", claim.pairId).executeTakeFirstOrThrow();
      if (pair.state === "updating") return; // Update transition retains the same fixture lease.
      if (pair.fixture_id) await trx.executor.updateTable("preview_pair_fixtures").set({ active_pair_id: null, revision: sql`revision + 1` })
        .where("fixture_id", "=", pair.fixture_id).where("active_pair_id", "=", claim.pairId)
        .returning("fixture_id").executeTakeFirstOrThrow();
      await trx.executor.updateTable("preview_pair_generations").set({ retired_at: new Date(now()).toISOString() })
        .where("pair_id", "=", claim.pairId).where("retired_at", "is", null).execute();
      await trx.executor.updateTable("preview_pairs").set({ state: "stopped", stopped_at: new Date(now()).toISOString(),
        claim_id: null, claim_expires_at: null, revision: sql`revision + 1`, next_attempt_at: null })
        .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("revision", "=", claim.revision)
        .where("claim_id", "=", claim.claimId).executeTakeFirstOrThrow();
    });
  } catch (error: unknown) {
    if (error instanceof PreviewPairConflictError) throw error;
    console.warn("[preview-pair] cleanup pending", error instanceof Error ? error.name : "UnknownError");
    await withPreviewPairClaim(db, claim, now(), async trx => {
      const pair = await trx.executor.selectFrom("preview_pairs").select("attempt").where("pair_id", "=", claim.pairId).executeTakeFirstOrThrow();
      const delay = Math.min(300_000, 15_000 * 2 ** Math.min(pair.attempt, 5));
      await trx.executor.updateTable("preview_pairs").set({ next_attempt_at: new Date(now() + delay).toISOString(),
        failure_code: "cleanup_unconfirmed", claim_id: null, claim_expires_at: null, revision: sql`revision + 1` })
        .where("pair_id", "=", claim.pairId).where("revision", "=", claim.revision).where("claim_id", "=", claim.claimId).execute();
    });
  }
}
