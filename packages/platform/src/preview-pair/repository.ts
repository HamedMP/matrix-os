import type { PlatformDB } from "../db.js";
import { lockUserMachineProvisioning } from "../db.js";
import { withAccountDeletionAdmission } from "../account-deletion/admission.js";
import { previewPairHandle } from "@matrix-os/contracts/preview-pair";

export type PreparePairMember = (pairId: string, generation: number, role: "owner" | "member") =>
  Promise<{ machineId: string; jobId: string; handle: string; actorId: string }>;

export class PreviewPairConflictError extends Error {
  constructor() { super("Preview pair is unavailable"); this.name = "PreviewPairConflictError"; }
}
export async function readPreviewPair(db: PlatformDB, pairId: string) {
  return db.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", pairId).executeTakeFirst();
}

export async function prepareLeasedPairMembers(db: PlatformDB, pairId: string, generation: number, prepare: PreparePairMember) {
  if (!db.executor.isTransaction) throw new Error("Pair preparation requires a transaction");
  const pair = await readPreviewPair(db, pairId);
  if (!pair || pair.generation !== generation || pair.state !== "preparing" || !pair.fixture_id) throw new PreviewPairConflictError();
  const fixture = await db.executor.selectFrom("preview_pair_fixtures").selectAll().where("fixture_id", "=", pair.fixture_id)
    .where("active_pair_id", "=", pairId).executeTakeFirstOrThrow();
  const owners = [fixture.owner_actor_id, fixture.member_actor_id].sort();
  await withAccountDeletionAdmission(db, owners[0]!, first => withAccountDeletionAdmission(first, owners[1]!, async trx => {
    for (const owner of owners) await lockUserMachineProvisioning(trx, owner);
    for (const role of ["owner", "member"] as const) {
      const member = await prepare(pairId, generation, role);
      if (member.actorId !== (role === "owner" ? fixture.owner_actor_id : fixture.member_actor_id)
        || member.handle !== previewPairHandle(pair.pr, pairId, generation, role)) throw new PreviewPairConflictError();
      await trx.executor.insertInto("preview_pair_members").values({ pair_id: pairId, generation, role,
        actor_id: member.actorId, machine_id: member.machineId, job_id: member.jobId, handle: member.handle, observation: null })
        .onConflict(oc => oc.columns(["pair_id", "generation", "role"]).doNothing()).execute();
      const saved = await trx.executor.selectFrom("preview_pair_members").selectAll().where("pair_id", "=", pairId)
        .where("generation", "=", generation).where("role", "=", role).executeTakeFirstOrThrow();
      if (saved.machine_id !== member.machineId || saved.job_id !== member.jobId || saved.actor_id !== member.actorId
        || saved.handle !== member.handle) throw new PreviewPairConflictError();
    }
  }));
}
