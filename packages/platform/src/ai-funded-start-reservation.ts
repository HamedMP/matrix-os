import { FundedAiStartRequestSchema, FundedAiStartResponseSchema, type FundedAiStartResponse } from "@matrix-os/contracts";
import { sql } from "kysely";
import type { z } from "zod/v4";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { assertFundedAcceptanceIdentity, assertAcceptanceTransactionCurrent, type FundedAcceptanceScope } from "./ai-funded-acceptance-scope.js";
/** Extracted start state machine; default mode preserves existing closure and replay. */
export function createFundedStartReservation(options: {
  db: PlatformDB;
  now: () => Date;
  inFlightTtlMs: number;
  acceptanceScope?: FundedAcceptanceScope;
}) {
  return async function startReservation(input: z.input<typeof FundedAiStartRequestSchema>): Promise<FundedAiStartResponse> {
    const request = FundedAiStartRequestSchema.parse(input);
    const checked = options.now();
    const checkedAt = checked.toISOString();
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      // Acceptance-only lock ordering: trusted locator -> owner -> machine -> reservation.
      // The locator read does not authorize dispatch; the locked reservation is rechecked.
      let acceptanceMachine;
      if (options.acceptanceScope) {
        const locator = await trx.executor.selectFrom("ai_funded_usage_reservations")
          .select(["owner_id", "machine_id"]).where("reservation_id", "=", request.reservationId)
          .where("token_id", "=", request.tokenId).executeTakeFirst();
        if (!locator)
          throw new AiFundedPolicyError("unauthorized");
        await sql `SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${locator.owner_id}`}, 0))`.execute(trx.executor);
        acceptanceMachine = await trx.executor.selectFrom("user_machines")
          .select([
          "machine_id", "clerk_user_id", "runtime_slot", "runtime_token_epoch", "status", "activation_state", "deleted_at"
        ])
          .where("machine_id", "=", locator.machine_id).forShare().executeTakeFirst();
      }
      const reservation = await trx.executor.selectFrom("ai_funded_usage_reservations")
        .selectAll().where("reservation_id", "=", request.reservationId)
        .where("token_id", "=", request.tokenId).forUpdate().executeTakeFirst();
      if (!reservation)
        throw new AiFundedPolicyError("unauthorized");
      if (reservation.execution_admission_release !== null || reservation.charge_waiver !== null)
        throw new AiFundedPolicyError("reservation_closed");
      if (reservation.status === "in_flight") {
        if (reservation.start_response === null)
          throw new Error("In-flight reservation is missing its response");
        return FundedAiStartResponseSchema.parse(JSON.parse(reservation.start_response));
      }
      if (reservation.status !== "reserved")
        throw new AiFundedPolicyError("reservation_closed");
      if (options.acceptanceScope) {
        if (!acceptanceMachine || acceptanceMachine.machine_id !== reservation.machine_id || acceptanceMachine.clerk_user_id !== reservation.owner_id
          || acceptanceMachine.runtime_slot !== reservation.runtime_slot || acceptanceMachine.status !== "running"
          || acceptanceMachine.activation_state !== "authorized" || acceptanceMachine.deleted_at !== null)
          throw new AiFundedPolicyError("access_disabled");
        assertFundedAcceptanceIdentity(options.acceptanceScope, { ownerId: reservation.owner_id, machineId: reservation.machine_id, runtimeSlot: reservation.runtime_slot }, acceptanceMachine.runtime_token_epoch, options.now());
      }
      if (Date.parse(reservation.expires_at) <= checked.getTime()) {
        throw new AiFundedPolicyError("reservation_expired");
      }
      const claimed = await trx.executor.updateTable("ai_funded_usage_reservations")
        .set({ status: "starting" }).where("reservation_id", "=", reservation.reservation_id)
        .where("status", "=", "reserved").returning("reservation_id").executeTakeFirst();
      if (!claimed) {
        const latest = await trx.executor.selectFrom("ai_funded_usage_reservations")
          .select(["status", "start_response"])
          .where("reservation_id", "=", reservation.reservation_id).executeTakeFirstOrThrow();
        if (latest.status === "in_flight" && latest.start_response !== null) {
          return FundedAiStartResponseSchema.parse(JSON.parse(latest.start_response));
        }
        if (latest.status === "starting")
          throw new AiFundedPolicyError("rate_limited");
        throw new AiFundedPolicyError("reservation_closed");
      }
      const expiresAt = new Date(checked.getTime() + options.inFlightTtlMs).toISOString();
      const response = FundedAiStartResponseSchema.parse({
        contractVersion: 1,
        reservationId: reservation.reservation_id,
        requestId: reservation.request_id,
        tokenId: reservation.token_id,
        startedAt: checkedAt,
        expiresAt,
        status: "in_flight",
      });
      const updated = await trx.executor.updateTable("ai_funded_usage_reservations").set({
        status: "in_flight",
        started_at: checkedAt,
        expires_at: expiresAt,
        start_response: JSON.stringify(response),
      }).where("reservation_id", "=", reservation.reservation_id).where("status", "=", "starting")
        .returning("reservation_id").executeTakeFirst();
      if (!updated) {
        const latest = await trx.executor.selectFrom("ai_funded_usage_reservations")
          .select(["status", "start_response"]).where("reservation_id", "=", reservation.reservation_id)
          .executeTakeFirstOrThrow();
        if (latest.status === "in_flight" && latest.start_response !== null) {
          return FundedAiStartResponseSchema.parse(JSON.parse(latest.start_response));
        }
        throw new AiFundedPolicyError("reservation_closed");
      }
      await assertAcceptanceTransactionCurrent(trx, options.acceptanceScope, options.now);
      return response;
    });
  };
}
