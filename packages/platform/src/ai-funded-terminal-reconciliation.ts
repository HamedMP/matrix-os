import { sql } from "kysely";
import type { PlatformDB } from "./db.js";
import { recoverTerminalOutcomes } from "./ai-funded-recovery-lifecycle.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";

/** A valid receipt stays durable if unrelated recovery history fails policy
 * validation. Database failures still abort the receipt transaction. */
export async function recoverFundedTerminalReceipt(
  executor: PlatformDB["executor"], ownerId: string, checked: Date,
): Promise<void> {
  await sql`SAVEPOINT funded_terminal_recovery`.execute(executor);
  try {
    await recoverTerminalOutcomes(executor, ownerId, checked);
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT funded_terminal_recovery`.execute(executor);
    if (!(error instanceof AiFundedPolicyError)) throw error;
    console.warn("[funded-ai] Terminal receipt retained without execution release", { code: error.code });
  } finally {
    await sql`RELEASE SAVEPOINT funded_terminal_recovery`.execute(executor);
  }
}

/** Run only after the financial transaction commits. An unrelated corrupt audit
 * must never roll back exact usage or turn its successful response into failure. */
export async function reconcileFundedTerminalAfterSettlement(
  db: PlatformDB,
  locator: { ownerId: string } | { reservationId: string; tokenId: string },
  now: () => Date,
): Promise<void> {
  try {
    await db.transaction(async (trx) => {
      const ownerId = "ownerId" in locator ? locator.ownerId : (await trx.executor
        .selectFrom("ai_funded_usage_reservations").select("owner_id")
        .where("reservation_id", "=", locator.reservationId).where("token_id", "=", locator.tokenId)
        .executeTakeFirstOrThrow()).owner_id;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${ownerId}`}, 0))`.execute(trx.executor);
      await recoverTerminalOutcomes(trx.executor, ownerId, now());
    });
  } catch (error) {
    console.warn("[funded-ai] Pending terminal recovery remains unavailable", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
