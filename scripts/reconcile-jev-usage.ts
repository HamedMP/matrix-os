#!/usr/bin/env bun
/** Operator-only review of expired Jev usage holds. Never run from a customer VPS. */
import { JEV_MODEL_ID } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { createAiFundedMeteringRepository, JEV_MANUAL_REVIEW_GRACE_MS } from "../packages/platform/src/ai-funded-metering-repository.js";
import { usageReservationLimit } from "../packages/platform/src/ai-funded-metering-helpers.js";
import { createPlatformDb } from "../packages/platform/src/db.js";

const Reference = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const Id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Amount = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function usage(): never {
  throw new Error("Usage: bun scripts/reconcile-jev-usage.ts list | reconcile <reservation-id> <request-id> <actual-cost-microusd> <evidence-ref> <reviewer-id> [--apply]");
}

async function main(): Promise<void> {
  const [command, reservationId, requestId, cost, evidenceRef, reviewer, ...rest] = process.argv.slice(2);
  if (command !== "list" && command !== "reconcile") usage();
  if (command === "list" && process.argv.slice(3).length > 0) usage();
  if (command === "reconcile" && (rest.some((item) => item !== "--apply") || rest.length > 1)) usage();
  const db = createPlatformDb(requiredEnv("PLATFORM_DATABASE_URL"));
  try {
    await db.ready;
    const now = new Date();
    if (command === "list") {
      const rows = await db.executor.selectFrom("ai_funded_usage_reservations")
        .select(["reservation_id", "request_id", "reserved_microusd", "expires_at"])
        .where("model_id", "=", JEV_MODEL_ID).where("status", "=", "in_flight")
        .where("expires_at", "<=", new Date(now.getTime() - JEV_MANUAL_REVIEW_GRACE_MS).toISOString())
        .orderBy("expires_at", "asc").limit(100).execute();
      console.log(JSON.stringify(rows.map((row) => ({
        reservationId: row.reservation_id,
        requestId: row.request_id,
        reservedMicrousd: Number(row.reserved_microusd),
        expiredAt: row.expires_at,
      })), null, 2));
      return;
    }
    const input = {
      reservationId: Id.parse(reservationId),
      expectedRequestId: Id.parse(requestId),
      actualCostMicrousd: Amount.parse(cost),
      evidenceRef: Reference.parse(evidenceRef),
      reviewer: Id.parse(reviewer),
    };
    const row = await db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["request_id", "token_id", "model_id", "status", "expires_at", "authorization_response"])
      .where("reservation_id", "=", input.reservationId).executeTakeFirst();
    if (!row || row.model_id !== JEV_MODEL_ID || (row.status !== "in_flight" && row.status !== "settled")
      || row.request_id !== input.expectedRequestId
      || (row.status === "in_flight" && Date.parse(row.expires_at) + JEV_MANUAL_REVIEW_GRACE_MS > now.getTime())) {
      throw new Error("The reservation is not a reviewable Jev usage hold matching that request");
    }
    const limit = usageReservationLimit(row.authorization_response);
    if (limit === null || input.actualCostMicrousd > limit) throw new Error("Reviewed cost exceeds the reservation liability");
    const review = { ...input, maxCostMicrousd: limit, mode: rest.includes("--apply") ? "apply" : "dry-run" };
    if (!rest.includes("--apply")) {
      console.log(JSON.stringify(review, null, 2));
      return;
    }
    const repo = createAiFundedMeteringRepository({
      db,
      credentialHashSecret: requiredEnv("AI_FUNDED_CREDENTIAL_HASH_SECRET"),
      now: () => new Date(),
      policyFreshnessMs: 60_000,
      reservationTtlMs: 300_000,
      inFlightTtlMs: 30 * 60_000,
    });
    const settlement = await repo.reconcileUnknownJevUsage({ ...input, tokenId: row.token_id });
    console.log(JSON.stringify({ ...review, status: settlement.status, settledAt: settlement.settledAt }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Jev reconciliation failed");
  process.exitCode = 1;
});
