import type { PlatformDB, UserMachineRecord } from "./db.js";
import type { HetznerClient } from "./customer-vps-hetzner.js";

type DeletionSubject = Pick<UserMachineRecord,
  "machineId" | "provisioningClass" | "handle" | "deletedAt" | "status" | "hetznerServerId">;
type DeletionProvider = Pick<HetznerClient, "getServer" | "listServersByLabel">;
const HISTORY_LIMIT = 100;

/** Read-only proof: a tombstone or accepted provider DELETE does not stop billing. */
export async function previewDeletionProof(
  row: DeletionSubject,
  provider: DeletionProvider,
  db: PlatformDB,
  deadline = Date.now() + 10000,
): Promise<{ previewDeletionConfirmed?: boolean }> {
  if (row.provisioningClass !== "preview" || !/^pr-[1-9][0-9]*$/.test(row.handle)
    || !row.deletedAt || row.status !== "deleted") return {};
  const held = { previewDeletionConfirmed: false };
  if (!provider.listServersByLabel || Date.now() >= deadline) return held;
  await db.ready;
  // GitHub job cancellation cannot stop an already admitted platform create.
  // Keep ambiguous jobs reserved until reconciliation or operator recovery settles them.
  const pending = await db.executor.selectFrom("provisioning_jobs").select("job_id")
    .where("machine_id", "=", row.machineId).where("status", "in", ["queued", "running"])
    .executeTakeFirst();
  if (pending) return held;
  const cleanup = await db.executor.selectFrom("provider_deletion_queue").select("provider_server_id")
    .where("machine_id", "=", row.machineId).limit(HISTORY_LIMIT + 1).execute();
  if (cleanup.length > HISTORY_LIMIT) return held;
  // Include completed outbox entries: accepted deletion is weaker than live absence.
  const ids = new Set(cleanup.map((item) => Number(item.provider_server_id)));
  if (row.hetznerServerId !== null) ids.add(Number(row.hetznerServerId));
  for (const id of ids) {
    if (Date.now() >= deadline) return held;
    if (!Number.isSafeInteger(id) || id < 1 || await provider.getServer(id)) return held;
  }
  // Also covers duplicates and creates whose response was lost before ID persistence.
  if (Date.now() >= deadline) return held;
  const servers = await provider.listServersByLabel(`machine_id=${row.machineId}`);
  return { previewDeletionConfirmed: servers.length === 0 };
}

/** Recover all durable identities, including tombstones missing from active fleet. */
export async function previewScopeDeletionProof(
  db: PlatformDB,
  provider: DeletionProvider,
  scope: { owner: string; pr: number },
): Promise<{ confirmed: boolean }> {
  if (!/^user_[A-Za-z0-9]+$/.test(scope.owner) || !Number.isSafeInteger(scope.pr) || scope.pr < 1)
    throw new Error("Invalid preview cleanup scope");
  await db.ready;
  const handle = `pr-${scope.pr}`;
  const rows = await db.executor.selectFrom("user_machines")
    .select(["machine_id", "provisioning_class", "handle", "deleted_at", "status", "hetzner_server_id"])
    .where("clerk_user_id", "=", scope.owner).where("handle", "=", handle)
    .where("provisioning_class", "=", "preview").where("runtime_slot", "in", [handle, "preview"])
    .limit(HISTORY_LIMIT + 1).execute();
  if (rows.length > HISTORY_LIMIT) return { confirmed: false };
  const deadline = Date.now() + 10000;
  for (const row of rows) {
    const proof = await previewDeletionProof({
      machineId: row.machine_id, provisioningClass: "preview", handle: row.handle,
      deletedAt: row.deleted_at, status: row.status,
      hetznerServerId: row.hetzner_server_id === null ? null : Number(row.hetzner_server_id),
    }, provider, db, deadline);
    if (proof.previewDeletionConfirmed !== true) return { confirmed: false };
  }
  return { confirmed: true };
}
