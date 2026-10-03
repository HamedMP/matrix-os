import { sql } from "kysely";
import type { FundedAiPriorityReason, FundedAiRequestClass } from "@matrix-os/contracts";
import type { PlatformDB } from "./db.js";

export const PRIORITY_CLAIM_TTL_MS = 2 * 60_000;
export const MAX_PRIORITY_CLAIMS_PER_OWNER = 16;

type Executor = PlatformDB["executor"];
export type FundedBillingMode = "usage" | "hold";

export type FundedPriorityDecision =
  | { kind: "proceed" }
  | { kind: "rejected"; reason: FundedAiPriorityReason };

interface PriorityInput {
  ownerId: string;
  machineId: string;
  runtimeSlot: string;
  /** Gateway turn identity; `""` groups keyless requests at the runtime level. */
  claimKey: string;
  requestClass: FundedAiRequestClass;
  billingMode: FundedBillingMode;
  checked: Date;
}

/** Usage-mode admission is owner-exclusive; hold-mode requests only conflict with usage. */
function conflicts(left: FundedBillingMode, right: FundedBillingMode): boolean {
  return left === "usage" || right === "usage";
}

export async function findConflictingActiveReservation(
  executor: Executor,
  ownerId: string,
  billingMode: FundedBillingMode,
): Promise<boolean> {
  const active = await executor.selectFrom("ai_funded_usage_reservations")
    .select("reservation_id").where("owner_id", "=", ownerId)
    .where("status", "in", ["reserved", "starting", "in_flight", "settling"])
    .where("execution_admission_release", "is", null)
    .$if(billingMode !== "usage", (query) => query.where(
      sql<boolean>`authorization_response::jsonb #>> '{reservation,billingMode}' = 'usage'`,
    )).limit(1).executeTakeFirst();
  return active !== undefined;
}

/**
 * Owner-wide interactive priority. Must run inside the authorization
 * transaction after the owner advisory lock. Claims are keyed to the
 * requesting runtime slot and the gateway's turn claim key, so relay retries
 * (new request ids) and credential rotation keep their place and distinct
 * turns on one runtime keep their order. A rejected decision may have written a claim, so
 * callers must commit the transaction before reporting the rejection.
 */
export async function evaluateFundedPriority(executor: Executor, input: PriorityInput): Promise<FundedPriorityDecision> {
  const checkedAt = input.checked.toISOString();
  const liveClaims = await executor.selectFrom("ai_funded_priority_claims")
    .selectAll().where("owner_id", "=", input.ownerId).where("expires_at", ">", checkedAt)
    .orderBy("created_at").orderBy("machine_id").orderBy("runtime_slot").orderBy("claim_key")
    .limit(MAX_PRIORITY_CLAIMS_PER_OWNER + 1).execute();
  const isOwnSlot = (claim: { machine_id: string; runtime_slot: string; claim_key: string }) =>
    claim.machine_id === input.machineId && claim.runtime_slot === input.runtimeSlot && claim.claim_key === input.claimKey;
  const otherConflicting = liveClaims.filter((claim) => !isOwnSlot(claim) && conflicts(input.billingMode, claim.billing_mode));

  if (input.requestClass === "background") {
    // A runtime's own interactive claim holds its background work too.
    return liveClaims.some((claim) => conflicts(input.billingMode, claim.billing_mode))
      ? { kind: "rejected", reason: "priority_hold" }
      : { kind: "proceed" };
  }

  const ownIndex = liveClaims.findIndex(isOwnSlot);
  const olderClaimWaiting = otherConflicting.some((claim) => ownIndex < 0 || liveClaims.indexOf(claim) < ownIndex);
  const slotBusy = await findConflictingActiveReservation(executor, input.ownerId, input.billingMode);

  if (!slotBusy && !olderClaimWaiting) {
    if (ownIndex >= 0) {
      // Consumed atomically with the reservation this transaction is about to write.
      await executor.deleteFrom("ai_funded_priority_claims")
        .where("owner_id", "=", input.ownerId).where("machine_id", "=", input.machineId)
        .where("runtime_slot", "=", input.runtimeSlot).where("claim_key", "=", input.claimKey).execute();
    }
    return { kind: "proceed" };
  }

  const ownClaim = ownIndex >= 0 ? liveClaims[ownIndex] : undefined;
  if (ownClaim && ownClaim.billing_mode === "hold" && input.billingMode === "usage") {
    // A usage attempt conflicts with more work; widen what the claim holds without moving it.
    await executor.updateTable("ai_funded_priority_claims").set({ billing_mode: "usage" })
      .where("owner_id", "=", input.ownerId).where("machine_id", "=", input.machineId)
      .where("runtime_slot", "=", input.runtimeSlot).where("claim_key", "=", input.claimKey).execute();
  }
  if (ownIndex < 0) {
    if (liveClaims.length >= MAX_PRIORITY_CLAIMS_PER_OWNER) return { kind: "rejected", reason: "priority_full" };
    const expiresAt = new Date(input.checked.getTime() + PRIORITY_CLAIM_TTL_MS).toISOString();
    // Only an expired row for this slot may be replaced; a live claim is never extended.
    await executor.insertInto("ai_funded_priority_claims").values({
      owner_id: input.ownerId,
      machine_id: input.machineId,
      runtime_slot: input.runtimeSlot,
      claim_key: input.claimKey,
      billing_mode: input.billingMode,
      created_at: checkedAt,
      expires_at: expiresAt,
    }).onConflict((conflict) => conflict.columns(["owner_id", "machine_id", "runtime_slot", "claim_key"]).doUpdateSet({
      billing_mode: input.billingMode,
      created_at: checkedAt,
      expires_at: expiresAt,
    }).where("ai_funded_priority_claims.expires_at", "<=", checkedAt)).execute();
  }
  return { kind: "rejected", reason: slotBusy ? "slot_busy" : "priority_queue" };
}

export async function deleteExpiredPriorityClaims(executor: Executor, checkedAt: string, limit: number): Promise<number> {
  const deleted = await sql<{ owner_id: string }>`
    DELETE FROM ai_funded_priority_claims
    WHERE (owner_id, machine_id, runtime_slot, claim_key) IN (
      SELECT owner_id, machine_id, runtime_slot, claim_key FROM ai_funded_priority_claims
      WHERE expires_at <= ${checkedAt}
      ORDER BY expires_at
      LIMIT ${limit}
    )
    RETURNING owner_id
  `.execute(executor);
  return deleted.rows.length;
}
