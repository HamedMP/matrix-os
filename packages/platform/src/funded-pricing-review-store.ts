import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  currentFundedAiPricingReview,
  FUNDED_PRICING_CATALOG,
  FundedAiPricingReviewSchema,
  type FundedAiPricingReview,
} from "@matrix-os/contracts";
import type { PlatformDB } from "./db.js";

type JobKind = "review" | "watchdog";
const LEASE_MS = 5 * 60_000;
const REVIEW_INTERVAL_MS = 24 * 60 * 60_000;
const REVIEW_RETRY_MS = 60 * 60_000;
const WATCHDOG_INTERVAL_MS = 15 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 1_500;

type ReviewRow = {
  model_id: string;
  version: string;
  reviewed_at: Date | string;
  valid_through: Date | string;
  source_digest: string;
  blocked_at: Date | string | null;
};

function parseReview(row: ReviewRow): FundedAiPricingReview {
  return FundedAiPricingReviewSchema.parse({
    modelId: row.model_id,
    version: row.version,
    reviewedAt: new Date(row.reviewed_at).toISOString(),
    validThrough: new Date(row.valid_through).toISOString(),
    sourceDigest: row.source_digest,
    blockedAt: row.blocked_at === null ? null : new Date(row.blocked_at).toISOString(),
  });
}

export function createFundedPricingReviewStore(db: PlatformDB, now = () => new Date()) {
  let pendingSnapshot: Promise<FundedAiPricingReview[]> | undefined;

  function list(): Promise<FundedAiPricingReview[]> {
    if (pendingSnapshot) return pendingSnapshot;
    const unavailable = () => new Error("Pricing review snapshot unavailable");
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(unavailable());
      }, SNAPSHOT_TIMEOUT_MS).unref();
    });
    const operation = (async () => {
      await db.ready;
      if (expired) throw unavailable();
      return db.transaction(async (trx) => {
        if (expired) throw unavailable();
        await sql`SET LOCAL statement_timeout = '1500ms'`.execute(trx.executor);
        if (expired) throw unavailable();
        const rows = await sql<ReviewRow>`
          SELECT model_id, version, reviewed_at, valid_through, source_digest, blocked_at
          FROM ai_funded_pricing_reviews ORDER BY model_id LIMIT 64
        `.execute(trx.executor);
        return rows.rows.map(parseReview);
      });
    })();
    pendingSnapshot = Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
    // A caller timeout does not cancel pool acquisition. Keep the slot until the
    // operation settles so repeated readiness checks cannot queue more reads.
    const release = () => { pendingSnapshot = undefined; };
    void operation.then(release, release);
    return pendingSnapshot;
  }

  return {
    list,

    async readCurrent(modelId: string, at = now()): Promise<{ version: string; validThrough: string } | null> {
      if (!Object.hasOwn(FUNDED_PRICING_CATALOG, modelId)) return null;
      const review = (await list()).find((entry) => entry.modelId === modelId);
      if (!review) return null;
      if (!currentFundedAiPricingReview(review, at)) return null;
      return { version: review.version, validThrough: review.blockedAt !== null && review.blockedAt < review.validThrough
        ? review.blockedAt : review.validThrough };
    },

    async save(review: FundedAiPricingReview, leaseId: string): Promise<boolean> {
      const parsed = FundedAiPricingReviewSchema.safeParse(review);
      if (!parsed.success || !Object.hasOwn(FUNDED_PRICING_CATALOG, review.modelId)
        || FUNDED_PRICING_CATALOG[review.modelId]?.version !== review.version
        || Date.parse(review.reviewedAt) > now().getTime()) return false;
      await db.ready;
      const evidenceId = createHash("sha256").update(JSON.stringify([
        review.modelId, review.version, review.reviewedAt, review.validThrough, review.sourceDigest, review.blockedAt,
      ])).digest("hex");
      // Lock the lease row inside the same statement as the write. An expired
      // runner cannot publish a review after another replica acquires the job.
      const rows = await sql<{ model_id: string }>`
        WITH owned AS (
          SELECT kind FROM ai_funded_pricing_job_state
          WHERE kind = 'review' AND lease_id = ${leaseId} AND lease_until > ${now().toISOString()}::timestamptz
          FOR UPDATE
        ), published AS (
        INSERT INTO ai_funded_pricing_reviews AS old
          (model_id, version, reviewed_at, valid_through, source_digest, blocked_at)
        SELECT ${review.modelId}, ${review.version}, ${review.reviewedAt}::timestamptz,
          ${review.validThrough}::timestamptz, ${review.sourceDigest}, ${review.blockedAt}::timestamptz
        FROM owned
        ON CONFLICT (model_id) DO UPDATE SET
          version = excluded.version, reviewed_at = excluded.reviewed_at,
          valid_through = excluded.valid_through, source_digest = excluded.source_digest,
          blocked_at = excluded.blocked_at
        WHERE old.reviewed_at < excluded.reviewed_at OR (
          old.reviewed_at = excluded.reviewed_at AND old.version = excluded.version AND (
            (old.blocked_at IS NULL AND excluded.blocked_at IS NOT NULL)
            OR (old.valid_through = excluded.valid_through AND old.source_digest = excluded.source_digest
              AND old.blocked_at IS NOT DISTINCT FROM excluded.blocked_at)
          )
        )
        RETURNING model_id, version, reviewed_at, valid_through, source_digest, blocked_at
        ), archived AS (
          INSERT INTO ai_funded_pricing_review_history
            (evidence_id, model_id, version, reviewed_at, valid_through, source_digest, blocked_at)
          SELECT ${evidenceId}, model_id, version, reviewed_at, valid_through, source_digest, blocked_at
          FROM published ON CONFLICT (evidence_id) DO NOTHING
        )
        SELECT model_id FROM published
      `.execute(db.executor);
      return rows.rows.length === 1;
    },

    async claim(kind: JobKind, at: Date): Promise<string | null> {
      await db.ready;
      const leaseId = randomUUID();
      const observedAt = at.toISOString();
      const leaseUntil = new Date(at.getTime() + LEASE_MS).toISOString();
      const rows = await sql<{ lease_id: string }>`
        INSERT INTO ai_funded_pricing_job_state AS state (kind, lease_id, lease_until, next_run_at, first_claimed_at)
        VALUES (${kind}, ${leaseId}, ${leaseUntil}::timestamptz, ${observedAt}::timestamptz, ${observedAt}::timestamptz)
        ON CONFLICT (kind) DO UPDATE SET lease_id = excluded.lease_id, lease_until = excluded.lease_until
        WHERE state.next_run_at <= ${observedAt}::timestamptz
          AND (state.lease_until IS NULL OR state.lease_until <= ${observedAt}::timestamptz)
        RETURNING lease_id
      `.execute(db.executor);
      return rows.rows[0]?.lease_id ?? null;
    },

    async finish(kind: JobKind, leaseId: string, at: Date, success: boolean): Promise<void> {
      await db.ready;
      const delay = kind === "watchdog" ? WATCHDOG_INTERVAL_MS : success ? REVIEW_INTERVAL_MS : REVIEW_RETRY_MS;
      await sql`
        UPDATE ai_funded_pricing_job_state
        SET lease_id = NULL, lease_until = NULL,
          next_run_at = ${new Date(at.getTime() + delay).toISOString()}::timestamptz,
          last_successful_at = CASE WHEN ${success} THEN ${at.toISOString()}::timestamptz ELSE last_successful_at END
        WHERE kind = ${kind} AND lease_id = ${leaseId} AND lease_until > ${at.toISOString()}::timestamptz
      `.execute(db.executor);
    },

    async watchdogStatus(): Promise<{ firstWatchdogClaim: Date; lastSuccessfulReview: Date | null }> {
      await db.ready;
      const rows = await sql<{ first_claimed_at: Date | string; last_successful_at: Date | string | null }>`
        SELECT watchdog.first_claimed_at, review.last_successful_at
        FROM ai_funded_pricing_job_state AS watchdog
        LEFT JOIN ai_funded_pricing_job_state AS review ON review.kind = 'review'
        WHERE watchdog.kind = 'watchdog'
      `.execute(db.executor);
      const row = rows.rows[0];
      if (!row) throw new Error("Pricing watchdog claim missing");
      return {
        firstWatchdogClaim: new Date(row.first_claimed_at),
        lastSuccessfulReview: row.last_successful_at === null ? null : new Date(row.last_successful_at),
      };
    },
  };
}
