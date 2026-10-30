import type {PlatformDB} from "./db.js";
import type {ProvisioningJobRecord} from "./customer-vps-provisioning-jobs.js";

/** Fence progress writes to the exact dispatcher lease, including reclaimed jobs. */
function claimed(db:PlatformDB,job:ProvisioningJobRecord){
 return db.executor.updateTable("provisioning_jobs").where("job_id","=",job.jobId)
  .where("machine_id","=",job.machineId).where("status","=","running")
  .where("attempts","=",job.attempts).where("lease_expires_at","=",job.leaseExpiresAt!);
}
export async function markPairCreateIntent(db:PlatformDB,job:ProvisioningJobRecord,now:string){
 const row=await claimed(db,job).set({activation_step:"creating",updated_at:now}).returning("job_id").executeTakeFirst();
 if(!row)throw new Error("Pair provisioning unavailable");
}
/** Normal provider progress is polled by the next pair pass, never a detached task. */
export async function releasePairProvisioningPass(db:PlatformDB,job:ProvisioningJobRecord,now:string){
 await claimed(db,job).set({status:"queued",lease_expires_at:null,available_at:now,updated_at:now}).execute();
}
