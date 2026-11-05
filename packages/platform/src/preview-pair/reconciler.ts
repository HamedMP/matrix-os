import { sql } from "kysely";
import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairShaSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import { PreviewPairCandidateSchema, type PreviewPairCandidate } from "./provenance.js";
import { readPreviewPair, recordPreviewPairCurrency, PreviewPairConflictError, type PreparePairMember } from "./repository.js";
import { promoteQueuedPreviewPair } from "./admission.js";
import { claimPreviewPair, requestPreviewPairStop, withPreviewPairClaim, type PreviewPairClaim } from "./lifecycle.js";
import { cleanupPreviewPair, type PreviewPairCleanupAdapters } from "./cleanup.js";
import { advancePreviewPairUpdate } from "./update.js";
import { refreshPreviewPairReadiness, type PreviewPairReadinessAdapters } from "./readiness.js";
import { previewPairOperation, PreviewPairOperationTimeout } from "./operation.js";

export interface PreviewPairActivationContext {
  pairId: string; generation: number; candidate: PreviewPairCandidate;
  members: Array<{ role: "owner" | "member"; machineId: string; jobId: string; actorId: string; handle: string }>;
}
export interface PreviewPairReconcilerDeps {
  db: PlatformDB; config: EnabledPreviewPairConfig; prepare: PreparePairMember;
  verifyFixtures(signal: AbortSignal): Promise<boolean>;
  activate(context: PreviewPairActivationContext, claim: PreviewPairClaim, signal: AbortSignal): Promise<boolean>;
  inspectRequest(input: { pairId: string; pr: number; generation: number }, signal: AbortSignal): Promise<unknown>;
  readiness: PreviewPairReadinessAdapters; cleanup: PreviewPairCleanupAdapters; now?: () => number;
}
const RequestState = z.strictObject({ open: z.boolean(), requested: z.boolean(), sourceSha: PreviewPairShaSchema });

export function createPreviewPairReconciler(deps: PreviewPairReconcilerDeps) {
  const { db } = deps, now = deps.now ?? Date.now;
  async function run(pairId: string, generation: number, revision: number) {
    PreviewPairIdSchema.parse(pairId); PreviewPairGenerationSchema.parse(generation); z.number().int().positive().parse(revision);
    let pair = await readPreviewPair(db, pairId);
    if (!pair || pair.generation !== generation || pair.revision !== revision) throw new PreviewPairConflictError();
    if (pair.state === "stopped") return pair;
    if (!deps.config.admissionEnabled && ["queued", "preparing", "updating"].includes(pair.state)) {
      return requestPreviewPairStop(db, pairId, generation, revision, now());
    }
    if (pair.state !== "cleanup_pending" && (Date.parse(pair.expires_at) <= now() || pair.state === "failed")) {
      return requestPreviewPairStop(db, pairId, generation, revision, now());
    }
    if (pair.claim_id && pair.claim_expires_at && Date.parse(pair.claim_expires_at) > now()) throw new PreviewPairConflictError();
    let requestKnown = pair.state === "cleanup_pending";
    if (pair.state !== "cleanup_pending") {
      try {
        const request = RequestState.parse(await previewPairOperation(signal => deps.inspectRequest({ pairId, pr: pair!.pr, generation }, signal)));
        if (!request.open || !request.requested) return requestPreviewPairStop(db, pairId, generation, revision, now());
        pair = await recordPreviewPairCurrency(db, pair, request.sourceSha); requestKnown = true;
      } catch (error: unknown) {
        if (error instanceof PreviewPairConflictError) throw error;
        console.warn("[preview-pair] request state unavailable", error instanceof Error ? error.name : "UnknownError");
        if (pair.state !== "updating") {
          const updated = await db.executor.updateTable("preview_pairs").set({ failure_code: "controller_unavailable",
            next_attempt_at: new Date(now() + 30_000).toISOString(), revision: sql`revision + 1` })
            .where("pair_id", "=", pairId).where("revision", "=", pair.revision).returningAll().executeTakeFirst();
          return updated ?? (await readPreviewPair(db, pairId))!;
        }
      }
    }
    if (pair.state === "queued") {
      if (!await previewPairOperation(signal => deps.verifyFixtures(signal))) throw new PreviewPairConflictError();
      return promoteQueuedPreviewPair(db, deps.config, pairId, pair.revision, deps.prepare, now());
    }
    const claim = await claimPreviewPair(db, pairId, generation, pair.revision, now());
    try {
      if (pair.state === "cleanup_pending" || pair.state === "updating") {
        await cleanupPreviewPair(db, claim, deps.cleanup, now);
        const current = (await readPreviewPair(db, pairId))!;
        if (current.state === "updating" && current.claim_id === claim.claimId && current.revision === claim.revision) {
          if (requestKnown) return advancePreviewPairUpdate(db, claim, deps.prepare, now());
          await release(claim, 30_000);
        }
        return (await readPreviewPair(db, pairId))!;
      }
      const snapshot = await withPreviewPairClaim(db, claim, now(), async trx => {
        const selected = await trx.executor.selectFrom("preview_pair_generations").select(["candidate", "ready_at"])
          .where("pair_id", "=", pairId).where("generation", "=", generation).executeTakeFirstOrThrow();
        const members = await trx.executor.selectFrom("preview_pair_members as member").innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
          .select(["member.role", "member.machine_id", "member.job_id", "member.actor_id", "member.handle", "machine.provisioned_at"])
          .where("member.pair_id", "=", pairId).where("member.generation", "=", generation).execute();
        if (members.length !== 2) throw new PreviewPairConflictError();
        return { candidate: PreviewPairCandidateSchema.parse(selected.candidate), readyAt: selected.ready_at, members };
      });
      if (!snapshot.readyAt && snapshot.members.some(member => now() - Date.parse(member.provisioned_at) > 30 * 60_000)) {
        return requestPreviewPairStop(db, pairId, generation, claim.revision, now());
      }
      if (pair.state !== "ready") {
        const context: PreviewPairActivationContext = { pairId, generation, candidate: snapshot.candidate,
          members: snapshot.members.map(member => ({ role: member.role, machineId: member.machine_id,
            jobId: member.job_id, actorId: member.actor_id, handle: member.handle })) };
        await withPreviewPairClaim(db, claim, now(), async () => undefined);
        let activated = false;
        try { activated = await previewPairOperation(signal => deps.activate(context, claim, signal)); }
        catch (error: unknown) {
          if (!(error instanceof PreviewPairOperationTimeout)) throw error;
          // Provider work is durable and resumes under a fresh claim. Its deadline
          // bounds this pass; it does not prove that server creation failed.
        }
        if (!activated) { await release(claim, 15_000); return (await readPreviewPair(db, pairId))!; }
      }
      await refreshPreviewPairReadiness(db, claim, deps.config, deps.readiness, now);
    } catch (error: unknown) {
      console.warn("[preview-pair] reconciliation pending", error instanceof Error ? error.name : "UnknownError");
      try {
        await withPreviewPairClaim(db, claim, now(), async trx => {
          await trx.executor.updateTable("preview_pairs").set({ state: "failed", failure_code: "activation_unavailable",
            next_attempt_at: new Date(now() + 15_000).toISOString(), claim_id: null, claim_expires_at: null, revision: sql`revision + 1` })
            .where("pair_id", "=", pairId).where("revision", "=", claim.revision).where("claim_id", "=", claim.claimId).execute();
        });
      } catch (stale: unknown) { console.warn("[preview-pair] reconciliation superseded", stale instanceof Error ? stale.name : "UnknownError"); }
    }
    return (await readPreviewPair(db, pairId))!;
  }
  async function release(claim: PreviewPairClaim, delay: number) {
    await withPreviewPairClaim(db, claim, now(), async trx => {
      await trx.executor.updateTable("preview_pairs").set({ claim_id: null, claim_expires_at: null,
        next_attempt_at: new Date(now() + delay).toISOString(), revision: sql`revision + 1` })
        .where("pair_id", "=", claim.pairId).where("revision", "=", claim.revision).where("claim_id", "=", claim.claimId).execute();
    });
  }
  return { run };
}
