import { sql, type QueryExecutorProvider } from "kysely";
import { PreviewPairHandleSchema } from "@matrix-os/contracts/preview-pair";
import { logicalRuntimeIdFor } from "./runtime-identity.js";

export type CollaborationRuntimeWriteAdmission = (
  transaction: QueryExecutorProvider & { readonly isTransaction: boolean },
  identity: { runtimeId: string; ownerId?: string },
) => Promise<void>;

export class CollaborationRuntimeWriteError extends Error {
  constructor() { super("Collaboration runtime is unavailable"); this.name = "CollaborationRuntimeWriteError"; }
}

/** Existing machine enrollment is the source of truth, even with pair admission disabled.
 * Take this lock BEFORE directory/endpoint locks. FOR SHARE conflicts with tombstone UPDATE;
 * FOR KEY SHARE would not fence a non-key status update under READ COMMITTED. */
export const admitCollaborationRuntimeWrite: CollaborationRuntimeWriteAdmission = async (trx, identity) => {
  if (!trx.isTransaction) throw new CollaborationRuntimeWriteError();
  const logical = logicalRuntimeIdFor(identity.runtimeId);
  const match = logical && /^vps-([0-9a-f-]{36})$/.exec(logical);
  if (!match) return; // Existing non-VPS enrollment behavior is unchanged.
  const result = await sql<{ clerk_user_id: string; handle: string; runtime_slot: string; provisioning_class: string;
    status: string; deleted_at: unknown; empty_access: boolean }>`SELECT clerk_user_id,handle,runtime_slot,provisioning_class,status,deleted_at,
      pg_catalog.cardinality(access_clerk_user_ids) = 0 AS empty_access
    FROM user_machines WHERE machine_id = ${match[1]} FOR SHARE`.execute(trx);
  const machine = result.rows[0];
  if (!machine) throw new CollaborationRuntimeWriteError();
  const pairHandle = PreviewPairHandleSchema.safeParse(machine.handle).success;
  const pairSlot = PreviewPairHandleSchema.safeParse(machine.runtime_slot).success;
  // Only the full reserved marker identifies a pair; cp-alice is a legal customer.
  if (!pairHandle && !pairSlot) return;
  if (!pairHandle || machine.runtime_slot !== machine.handle
    || machine.provisioning_class !== "preview" || machine.status !== "running" || machine.deleted_at !== null
    || !machine.empty_access || (identity.ownerId !== undefined && machine.clerk_user_id !== identity.ownerId)) {
    throw new CollaborationRuntimeWriteError();
  }
};
