import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "./migration-types.js";

export const FUNDED_CONSERVATIVE_FENCE_SCOPE = "funded-conservative-fence";
export const FUNDED_CONSERVATIVE_FENCE_TRIGGER = "ai_funded_conservative_settlement_fence";
export const FUNDED_CONSERVATIVE_FENCE_FUNCTION = "enforce_ai_funded_conservative_settlement_fence";

// Keep the body byte-stable: readiness compares the installed function source.
// Only execution metadata can change on a historical conservative receipt.
export const FUNDED_CONSERVATIVE_FENCE_BODY = `
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'settled' AND OLD.finalization_mode = 'conservative' THEN
    IF (to_jsonb(NEW) - ARRAY['terminal_outcome', 'execution_admission_release', 'execution_recovery_slot'])
        IS NOT DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['terminal_outcome', 'execution_admission_release', 'execution_recovery_slot']) THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.status IS DISTINCT FROM 'settled' OR NEW.finalization_mode IS DISTINCT FROM 'conservative' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid funded usage settlement'
    USING ERRCODE = '23514', CONSTRAINT = 'ai_funded_conservative_settlement_check';
END;
`;

/** Additive auxiliary scope: core schema generations/fingerprints remain intact. */
export async function migrateFundedConservativeFence(db: PlatformMigrationExecutor): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION ${sql.id(FUNDED_CONSERVATIVE_FENCE_FUNCTION)}()
    RETURNS trigger LANGUAGE plpgsql AS $fence$${sql.raw(FUNDED_CONSERVATIVE_FENCE_BODY)}$fence$`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ${sql.id(FUNDED_CONSERVATIVE_FENCE_TRIGGER)} ON ai_funded_usage_reservations`.execute(db);
  await sql`CREATE TRIGGER ${sql.id(FUNDED_CONSERVATIVE_FENCE_TRIGGER)} BEFORE INSERT OR UPDATE
    ON ai_funded_usage_reservations FOR EACH ROW
    EXECUTE FUNCTION ${sql.id(FUNDED_CONSERVATIVE_FENCE_FUNCTION)}()`.execute(db);
}

/** A migration marker alone cannot establish that legacy writers are fenced. */
export async function assertFundedConservativeFence(db: PlatformMigrationExecutor): Promise<void> {
  const result = await sql<{ valid: boolean }>`
    SELECT (t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 23
      AND t.tgattr::text = '' AND t.tgqual IS NULL AND t.tgnargs = 0
      AND octet_length(t.tgargs) = 0 AND t.tgconstraint = 0
      AND p.proname = ${FUNDED_CONSERVATIVE_FENCE_FUNCTION} AND p.pronamespace = c.relnamespace
      AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::regtype
      AND p.prokind = 'f' AND NOT p.prosecdef AND p.proconfig IS NULL
      AND l.lanname = 'plpgsql' AND p.prosrc = ${FUNDED_CONSERVATIVE_FENCE_BODY}) AS valid
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = 'ai_funded_usage_reservations'
      AND t.tgname = ${FUNDED_CONSERVATIVE_FENCE_TRIGGER}
  `.execute(db);
  if (result.rows.length !== 1 || result.rows[0]?.valid !== true) {
    throw new Error("Funded usage settlement fence is missing or invalid");
  }
}
