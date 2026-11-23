import { sql } from "kysely";
import type { PlatformDB } from "./db.js";

const activeAiStates = ["reserved", "starting", "in_flight", "settling"];
const activeSpeechStates = ["received", "reserved", "dispatching"];

/** Serialize the exact Preview runtime across funded Chat and speech, then
 * inspect both durable operation registries while the shared lock is held. */
export async function previewRuntimeOperationBusy(
  executor: PlatformDB["executor"],
  identity: { ownerId: string; machineId: string; runtimeSlot: string },
  speechActiveAfter: string,
): Promise<boolean> {
  const lockScope = `preview-runtime-operation:${identity.ownerId}:${identity.machineId}:${identity.runtimeSlot}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockScope}, 0))`.execute(executor);
  const activeAi = executor.selectFrom("ai_funded_usage_reservations")
    .select("reservation_id")
    .where("owner_id", "=", identity.ownerId)
    .where("machine_id", "=", identity.machineId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .where("status", "in", activeAiStates)
    .where("execution_admission_release", "is", null);
  const activeSpeech = executor.selectFrom("speech_operations")
    .select("operation_id")
    .where("owner_id", "=", identity.ownerId)
    .where("machine_id", "=", identity.machineId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .where("execution_state", "in", activeSpeechStates)
    .where("updated_at", ">", speechActiveAfter);
  const { busy } = await executor.selectNoFrom((eb) =>
    eb.or([eb.exists(activeAi), eb.exists(activeSpeech)]).as("busy"),
  ).executeTakeFirstOrThrow();
  return Boolean(busy);
}
