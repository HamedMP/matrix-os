/**
 * Legacy person-to-person ingestion lock (S18).
 *
 * The cutover refuses to activate while an undispositioned person-to-person
 * record exists. Counting those rows before the activation write is not enough
 * under READ COMMITTED: a legacy directory event can commit between the count
 * and the write, and the counting snapshot never sees it. Legacy ingestion and
 * cutover activation therefore take this schema-scoped transaction lock, which
 * serializes the final inventory-to-activation interval against a legacy insert
 * without locking organization directory traffic.
 */
import { sql, type QueryExecutorProvider } from "kysely";

/** Stable, arbitrary key; paired with the schema hash so tenants never collide. */
const LEGACY_INGESTION_LOCK_ID = 1_394_229_470;

export async function lockLegacyDirectoryIngestion(trx: QueryExecutorProvider): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), ${sql.lit(LEGACY_INGESTION_LOCK_ID)})`.execute(trx);
}
