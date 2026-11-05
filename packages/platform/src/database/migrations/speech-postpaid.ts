import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../migration-types.js";

/** Old Speech writers must fail before dispatch or roll back their whole debit. */
export async function migratePostpaidSpeechBoundary(db: PlatformMigrationExecutor) {
  await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT IF EXISTS ai_funded_speech_postpaid_state_check`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations ADD CONSTRAINT ai_funded_speech_postpaid_state_check CHECK (
    (authorization_response::jsonb ->> 'capability' = 'speech:transcribe'
      AND authorization_response::jsonb #>> '{reservation,billingPolicy}' = 'postpaid') IS NOT TRUE OR COALESCE(
    reserved_microusd = 0
    AND authorization_response::jsonb #>> '{reservation,billingMode}' = 'usage'
    AND authorization_response::jsonb #>> '{reservation,reservedMicrousd}' = '0'
    AND jsonb_typeof(authorization_response::jsonb #> '{reservation,maxCostMicrousd}') = 'number'
    AND (authorization_response::jsonb #>> '{reservation,maxCostMicrousd}')::bigint > 0
    AND jsonb_typeof(authorization_response::jsonb -> 'allowanceReservedMicrousd') = 'number'
    AND (CASE WHEN authorization_response::jsonb ->> 'fundingPolicy' = 'speech_monthly_v1' THEN
      (authorization_response::jsonb ->> 'allowanceReservedMicrousd')::bigint = (authorization_response::jsonb #>> '{reservation,maxCostMicrousd}')::bigint
      AND authorization_response::jsonb ->> 'allowancePeriodStart' = period_start
      ELSE (authorization_response::jsonb ->> 'allowanceReservedMicrousd')::bigint = 0
      AND authorization_response::jsonb ->> 'allowancePeriodStart' IS NULL END)
    AND (started_at IS NULL OR (start_response::jsonb ->> 'capability' = 'speech:transcribe'
      AND start_response::jsonb ->> 'billingPolicy' = 'postpaid'
      AND start_response::jsonb ->> 'startedAt' = started_at))
    AND ((status = 'reserved' AND started_at IS NULL AND actual_microusd IS NULL AND start_response IS NULL
        AND customer_charge_release IS NULL AND settlement_response IS NULL)
      OR (status = 'in_flight' AND started_at IS NOT NULL AND actual_microusd IS NULL
        AND customer_charge_release IS NULL AND settlement_response IS NULL)
      OR (status = 'expired' AND customer_charge_release IS NOT NULL AND actual_microusd IS NULL AND settlement_response IS NULL)
      OR (status = 'released' AND started_at IS NULL AND actual_microusd IS NULL AND customer_charge_release IS NULL
        AND released_at IS NOT NULL AND release_response::jsonb ->> 'capability' = 'speech:transcribe'
        AND release_response::jsonb ->> 'billingPolicy' = 'postpaid'
        AND (release_response::jsonb ->> 'releasedMicrousd')::bigint = 0)
      OR (status = 'settled' AND started_at IS NOT NULL AND actual_microusd IS NOT NULL AND settled_at IS NOT NULL
        AND finalization_mode = 'exact'
        AND settlement_response::jsonb ->> 'capability' = 'speech:transcribe'
        AND settlement_response::jsonb ->> 'billingPolicy' = 'postpaid'
        AND settlement_response::jsonb ->> 'status' = 'settled'
        AND settlement_response::jsonb ->> 'reservationId' = reservation_id
        AND settlement_response::jsonb ->> 'requestId' = request_id
        AND settlement_response::jsonb ->> 'tokenId' = token_id
        AND settlement_response::jsonb ->> 'settledAt' = settled_at
        AND (settlement_response::jsonb ->> 'actualCostMicrousd')::bigint = actual_microusd
        AND actual_microusd <= (authorization_response::jsonb #>> '{reservation,maxCostMicrousd}')::bigint
        AND (settlement_response::jsonb ->> 'chargedCostMicrousd')::bigint >= 0
        AND (settlement_response::jsonb ->> 'matrixAbsorbedMicrousd')::bigint >= 0
        AND (settlement_response::jsonb ->> 'chargedCostMicrousd')::bigint
          + (settlement_response::jsonb ->> 'matrixAbsorbedMicrousd')::bigint = actual_microusd)), FALSE))`.execute(db);
}
