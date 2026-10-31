import { previewPairHandle } from "@matrix-os/contracts/preview-pair";
import { getHostBundleRelease, type PlatformDB } from "../db.js";
import { PreviewPairCandidateSchema } from "./provenance.js";
import type { PreviewPairReadinessMember } from "./readiness.js";
import { PreviewPairConflictError } from "./repository.js";

export async function readCanonicalPreviewPairMember(db: PlatformDB, member: PreviewPairReadinessMember, now: () => number) {
    const row = await db.executor.selectFrom("preview_pair_members as member")
      .innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
      .innerJoin("preview_pairs as pair", "pair.pair_id", "member.pair_id")
      .innerJoin("preview_pair_generations as generation", join => join.onRef("generation.pair_id", "=", "member.pair_id").onRef("generation.generation", "=", "member.generation"))
      .selectAll("machine").select(["member.role", "member.actor_id", "member.retired_at", "member.generation", "pair.pr", "pair.pair_id", "pair.source_sha as canonical_source_sha", "generation.candidate"])
      .where("member.machine_id", "=", member.machineId).where("pair.state", "in", ["preparing", "ready"])
      .whereRef("pair.generation", "=", "member.generation").where("pair.expires_at", ">", new Date(now()).toISOString()).executeTakeFirst();
    if (!row || row.retired_at || row.deleted_at || row.status !== "running" || row.provisioning_class !== "preview"
      || row.role !== member.role || row.actor_id !== member.actorId || row.clerk_user_id !== member.actorId
      || row.handle !== member.handle || row.runtime_slot !== member.handle || row.runtime_token_epoch !== member.tokenEpoch
      || row.access_clerk_user_ids.length || row.handle !== previewPairHandle(row.pr, row.pair_id, row.generation, member.role)) throw new PreviewPairConflictError();
    const candidate = PreviewPairCandidateSchema.parse(row.candidate);
    const release = await getHostBundleRelease(db, candidate.hostBundleVersion);
    if (candidate.sourceSha !== row.canonical_source_sha || !release || release.channel !== null || release.sourcePr !== row.pr || release.sha256 !== candidate.hostBundleSha256
      || release.gitCommit !== candidate.sourceSha || row.image_version !== release.version) throw new PreviewPairConflictError();
    return { row, candidate };
  }
