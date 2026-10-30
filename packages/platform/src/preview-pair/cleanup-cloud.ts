import type { PlatformDB } from "../db.js";
import { previewPairHandle, PreviewPairDigestSchema } from "@matrix-os/contracts/preview-pair";
import type { PreviewPairCleanupMember } from "./cleanup.js";
import { withPreviewPairClaim, type PreviewPairClaim } from "./lifecycle.js";
import { PreviewPairConflictError } from "./repository.js";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { createPreviewPairCloudRetirement, type PreviewPairCloudRetirementOptions } from "./cloud-retirement.js";
export interface PreviewPairCloudCleanupOptions extends PreviewPairCloudRetirementOptions {
  db: PlatformDB; profileFingerprint?: string; now: () => number;
}

/** Member-backed retirement retains its original owner/machine/claim boundary. */
export function createPreviewPairCloudCleanup(options: PreviewPairCloudCleanupOptions) {
  if (options.profileFingerprint !== undefined) PreviewPairDigestSchema.parse(options.profileFingerprint);
  const retire = createPreviewPairCloudRetirement(options);
  async function canonical(member: PreviewPairCleanupMember, claim: PreviewPairClaim) {
    return withPreviewPairClaim(options.db, claim, options.now(), async trx => {
      const pair = await trx.executor.selectFrom("preview_pairs").select(["state", "pr"]).where("pair_id", "=", claim.pairId).executeTakeFirstOrThrow();
      if (member.pairId !== claim.pairId || member.generation > claim.generation || !["cleanup_pending", "updating"].includes(pair.state)) throw new PreviewPairConflictError();
      const row = await trx.executor.selectFrom("preview_pair_members as member")
        .innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
        .innerJoin("preview_pair_generations as generation", join => join.onRef("generation.pair_id", "=", "member.pair_id").onRef("generation.generation", "=", "member.generation"))
        .select(["member.role", "generation.candidate", "generation.source_sha"])
        .where("member.pair_id", "=", member.pairId).where("member.generation", "=", member.generation)
        .where("member.machine_id", "=", member.machineId).where("member.job_id", "=", member.jobId)
        .where("member.actor_id", "=", member.actorId).where("member.handle", "=", member.handle)
        .where("machine.clerk_user_id", "=", member.actorId).where("machine.handle", "=", member.handle)
        .where("machine.runtime_slot", "=", member.handle).where("machine.provisioning_class", "=", "preview").executeTakeFirst();
      if (!row || member.handle !== previewPairHandle(pair.pr, member.pairId, member.generation, row.role)) throw new PreviewPairConflictError();
      const candidate = PreviewPairCandidateSchema.parse(row.candidate);
      if (options.profileFingerprint && candidate.sourceProfileFingerprint !== options.profileFingerprint) throw new PreviewPairConflictError();
      if (candidate.sourceSha !== row.source_sha) throw new PreviewPairConflictError();
      return candidate;
    });
  }
  return (member: PreviewPairCleanupMember, claim: PreviewPairClaim, signal: AbortSignal): Promise<boolean> => retire(async () => {
    const candidate = await canonical(member, claim);
    return { pairId: member.pairId, generation: member.generation, sourceSha: candidate.platformSource.sha };
  }, signal);
}
