import { randomUUID } from "node:crypto";
import type { PlatformDB } from "../db.js";
import { insertProviderDeletion } from "../db.js";
import type { HetznerClient, HetznerServer } from "../customer-vps-hetzner.js";
import type { PreviewPairCleanupAdapters, PreviewPairCleanupMember } from "./cleanup.js";
import { withPreviewPairClaim, type PreviewPairClaim } from "./lifecycle.js";
import { PreviewPairConflictError } from "./repository.js";

/** Only the established provider client receives credentials; no URLs or shell commands. */
export function createPreviewPairProviderCleanup(db: PlatformDB, provider: HetznerClient,
  now: () => number): PreviewPairCleanupAdapters {
  async function canonical(member: PreviewPairCleanupMember, claim: PreviewPairClaim) {
    return withPreviewPairClaim(db, claim, now(), async trx => {
      if (member.pairId !== claim.pairId || member.generation > claim.generation) throw new PreviewPairConflictError();
      const binding = await trx.executor.selectFrom("preview_pair_members as member")
        .innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
        .innerJoin("provisioning_jobs as job", "job.job_id", "member.job_id")
        .select(["machine.hetzner_server_id", "job.status", "job.lease_expires_at", "job.activation_step", "job.provider_create_action_id"])
        .where("member.pair_id", "=", claim.pairId).where("member.generation", "=", member.generation)
        .where("member.machine_id", "=", member.machineId).where("member.job_id", "=", member.jobId)
        .where("member.actor_id", "=", member.actorId).where("member.handle", "=", member.handle)
        .where("machine.clerk_user_id", "=", member.actorId).where("machine.provisioning_class", "=", "preview")
        .where("machine.runtime_slot", "=", member.handle).where("machine.handle", "=", member.handle)
        .where("job.machine_id", "=", member.machineId).executeTakeFirst();
      if (!binding || (binding.hetzner_server_id === null ? null : Number(binding.hetzner_server_id)) !== member.providerServerId) throw new PreviewPairConflictError();
      return binding;
    });
  }
  async function inspect(member: PreviewPairCleanupMember) {
    if (!provider.inspectServersByLabel) throw new PreviewPairConflictError();
    const [exact, labels] = await Promise.all([
      member.providerServerId === null ? Promise.resolve(null) : provider.getServer(member.providerServerId),
      provider.inspectServersByLabel(`machine_id=${member.machineId}`),
    ]);
    if (labels.servers.length > 50) throw new PreviewPairConflictError();
    return { exact, ...labels };
  }
  function matches(server: HetznerServer, member: PreviewPairCleanupMember): boolean {
    return Number.isSafeInteger(server.id) && server.id > 0 && server.labels?.app === "matrix-os"
      && server.labels.machine_id === member.machineId && server.labels.clerk_user_id === member.actorId
      && server.labels.runtime_slot === member.handle;
  }
  return {
    async retire(member, claim) {
      await canonical(member, claim);
      const inventory = await inspect(member);
      const servers = inventory.exact ? [...inventory.servers, inventory.exact] : inventory.servers;
      if (servers.some(server => !matches(server, member))) throw new PreviewPairConflictError();
      await withPreviewPairClaim(db, claim, now(), async trx => {
        for (const server of servers) await insertProviderDeletion(trx, { id: randomUUID(), providerServerId: server.id,
          reason: "preview_pair_retire", machineId: member.machineId, handle: member.handle,
          nextAttemptAt: new Date(now()).toISOString(), createdAt: new Date(now()).toISOString() });
      });
    },
    async proveAbsent(member, claim) {
      const job = await canonical(member, claim);
      const inventory = await inspect(member);
      let creationSettled = inventory.complete && job.status !== "running"
        && (!job.lease_expires_at || Date.parse(job.lease_expires_at) + 30_000 <= now());
      const intents = await db.executor.selectFrom("golden_snapshot_create_intents")
        .select(["provider_create_action_id", "state"]).where("machine_id", "=", member.machineId)
        .where("state", "in", ["pending", "accepted"]).limit(4).execute();
      if (intents.length > 3) creationSettled = false;
      if (job.activation_step === "creating" && job.provider_create_action_id === null) creationSettled = false;
      const actions = [job.provider_create_action_id, ...intents.map(intent => intent.provider_create_action_id)];
      for (const intent of intents) if (intent.provider_create_action_id === null) creationSettled = false;
      for (const id of actions) if (id !== null) {
        const action = await provider.getAction(Number(id));
        if (!action || action.status === "running") creationSettled = false;
      }
      await canonical(member, claim);
      return { machineId: member.machineId, providerServerId: member.providerServerId,
        exactServerAbsent: inventory.exact === null, labeledServerIds: inventory.servers.map(server => server.id),
        creationSettled, observedAt: new Date(now()).toISOString() };
    },
  };
}
