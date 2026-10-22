import { sql } from "kysely";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";

/** Explicit review mode must match the actual deployed deletion namespace. */
export async function assertWaiverDeletionMode(db: PlatformDB, mode: "configured" | "disabled",
  apply: boolean, env: NodeJS.ProcessEnv) {
  if (mode === "configured") {
    if (Buffer.byteLength(env.ACCOUNT_DELETION_SECRET ?? "") < 32) throw new AiFundedPolicyError("unavailable");
    return;
  }
  if (env.ACCOUNT_DELETION_SECRET !== undefined
    || (env.ACCOUNT_DELETION_ENABLED !== undefined && env.ACCOUNT_DELETION_ENABLED !== "false")) {
    throw new AiFundedPolicyError("unavailable");
  }
  // No deployed hash secret means no per-owner tombstone can be reconstructed.
  // Freeze job inserts/state changes before financial locks, then require none active.
  if (apply) await sql`LOCK TABLE account_deletion_jobs IN SHARE MODE`.execute(db.executor);
  const job = await db.executor.selectFrom("account_deletion_jobs").select("owner_hash")
    .where("status", "!=", "cancelled").limit(1).executeTakeFirst();
  if (job) throw new AiFundedPolicyError("access_disabled");
}
