import { z } from "zod/v4";
import { PreviewPairGenerationSchema, PreviewPairIdSchema, PreviewPairRoleSchema, previewPairHandle } from "@matrix-os/contracts/preview-pair";
import type { CustomerVpsContext } from "../customer-vps-context.js";
import type { createCustomerVpsProvisioner } from "../customer-vps-provision.js";
import { getProvisioningJobByMachineId } from "../customer-vps-provisioning-jobs.js";
import { getUserMachine, getActiveUserMachineByClerkId } from "../db.js";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { PreviewPairConflictError } from "./repository.js";

/** Internal only: every authority-bearing field derives from the leased ledger. */
export async function preparePreviewPairMember(context: CustomerVpsContext,
  provisioner: ReturnType<typeof createCustomerVpsProvisioner>, pairId: string, generation: number,
  role: "owner" | "member") {
  z.tuple([PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairRoleSchema]).parse([pairId, generation, role]);
  const db = context.deps.db;
  if (!db.executor.isTransaction) throw new Error("Pair preparation requires a transaction");
  const pair = await db.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", pairId).forUpdate().executeTakeFirst();
  if (!pair || pair.generation !== generation || pair.state !== "preparing"
    || !pair.fixture_id || Date.parse(pair.expires_at) <= context.now().getTime()) throw new PreviewPairConflictError();
  const fixture = await db.executor.selectFrom("preview_pair_fixtures").selectAll()
    .where("fixture_id", "=", pair.fixture_id).where("active_pair_id", "=", pairId).executeTakeFirst();
  const artifact = await db.executor.selectFrom("preview_pair_generations").select("candidate")
    .where("pair_id", "=", pairId).where("generation", "=", generation).executeTakeFirst();
  const parsed = PreviewPairCandidateSchema.safeParse(artifact?.candidate);
  if (!fixture || !parsed.success || parsed.data.sourceSha !== pair.source_sha) throw new PreviewPairConflictError();
  const clerkUserId = role === "owner" ? fixture.owner_actor_id : fixture.member_actor_id;
  const handle = previewPairHandle(pair.pr, pairId, generation, role);
  const existing = await getActiveUserMachineByClerkId(db, clerkUserId, handle);
  if (existing) {
    const binding = await db.executor.selectFrom("preview_pair_members").select("machine_id")
      .where("pair_id", "=", pairId).where("generation", "=", generation).where("role", "=", role).executeTakeFirst();
    if (existing.provisioningClass !== "preview" || !binding || binding.machine_id !== existing.machineId) throw new PreviewPairConflictError();
  }
  const response = await provisioner.provision({ clerkUserId, handle, runtimeSlot: handle,
    bundleVersion: parsed.data.hostBundleVersion, accessClerkUserIds: [], developerTools: [] }, "preview", "prepare");
  const [machine, job] = await Promise.all([getUserMachine(db, response.machineId), getProvisioningJobByMachineId(db, response.machineId)]);
  if (!machine || !job || machine.clerkUserId !== clerkUserId || machine.handle !== handle
    || machine.runtimeSlot !== handle || machine.provisioningClass !== "preview" || machine.accessClerkUserIds.length
    || machine.imageVersion !== parsed.data.hostBundleVersion || machine.deletedAt !== null || job.status !== "queued") {
    throw new PreviewPairConflictError();
  }
  return { machineId: machine.machineId, jobId: job.jobId, handle, actorId: clerkUserId };
}
