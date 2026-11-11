import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { FUNDED_AI_READINESS_TIMEOUTS } from "@matrix-os/contracts";
import type { PlatformDB } from "./db.js";
import type { FundedModelProbeResult } from "./ai-funded-model-probes.js";
import { probeWithSignal } from "./ai-funded-jev-probe.js";

const MAX_ROWS = 128;
const MAX_PENDING_DB = 64;
const MAX_DB_DEADLINE_MS = 1_500;
// Acquisition commit, paid-probe admission and publication each retain a DB
// budget around the bounded Relay call. A live slow probe must not lose its
// lease to another replica before it can publish (or clean up on cancellation).
const LEASE_MS = FUNDED_AI_READINESS_TIMEOUTS.relayProbeMs + 3 * MAX_DB_DEADLINE_MS;
export const SHARED_FUNDED_HEALTH_TTL_MS = 300_000;
export const REVIEWED_FUNDED_HEALTH_TTL_MS = 900_000;
const NEGATIVE_TTL_MS = 5_000;
const RETRY_BACKOFF_MS = [60_000, 300_000, REVIEWED_FUNDED_HEALTH_TTL_MS] as const;
const pending = new Set<Promise<unknown>>();
interface Row {
  lease_token: string;
  ready: boolean | null;
  checked_ms: number | string | null;
  stale_ms: number | string | null;
  price_expiry_ms: number | string | null;
}

interface ProbeSchedule {
  previousRegularMs: number;
  regularMs: number;
  failureStreak: number;
  expedited: boolean;
}

export interface SharedProbeAttempt {
  expedited: boolean;
  recordDispatch(): void;
}

/** Only the digest is stored. A changed Relay origin, credential or local probe
 * configuration cannot reuse another deployment's health receipt. */
export function fundedProbeCacheKey(input: {
  modelId: string; relayOrigin: string; controlToken: string; dailyLimit: number; minuteLimit: number;
  review?: { version: string; validThrough: string };
}): string {
  return createHash("sha256").update(JSON.stringify(["priced-readiness-v2", FUNDED_AI_READINESS_TIMEOUTS.relayProbeMs, LEASE_MS, input.modelId,
    input.relayOrigin, input.controlToken, input.dailyLimit, input.minuteLimit,
    ...(input.review ? [input.review.version, input.review.validThrough] : [])])).digest("hex");
}

function fresh(row: Row | undefined, nowMs: number, reviewed: boolean): FundedModelProbeResult | undefined {
  if (!row || row.ready === null) return undefined;
  const checked = Number(row.checked_ms), stale = Number(row.stale_ms);
  const price = Number(row.price_expiry_ms);
  const maxAge = reviewed ? REVIEWED_FUNDED_HEALTH_TTL_MS : row.ready ? SHARED_FUNDED_HEALTH_TTL_MS : NEGATIVE_TTL_MS;
  if (!Number.isSafeInteger(checked) || !Number.isSafeInteger(stale)
    || checked > nowMs || stale <= nowMs || stale <= checked
    || stale - checked > maxAge
    || (row.ready && (!Number.isSafeInteger(price) || price < stale || price <= nowMs))) return undefined;
  return { ready: row.ready, checkedAt: new Date(checked).toISOString(), staleAfter: new Date(stale).toISOString(), ...(row.ready ? { priceValidThrough: new Date(price).toISOString() } : {}) };
}

/** Short DB operations retain their slot until they actually finish, even if a
 * caller times out. No delayed operation can start a paid request after abort. */
async function boundedDb<T>(db: PlatformDB, signal: AbortSignal, deadlineMs: number,
  work: (db: PlatformDB) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (pending.size >= MAX_PENDING_DB) throw new Error("Shared probe database busy");
  const operation = (async () => {
    await db.ready;
    signal.throwIfAborted();
    return db.transaction(async trx => {
      await sql`set local statement_timeout = '1500ms'`.execute(trx.executor);
      await sql`set local lock_timeout = '500ms'`.execute(trx.executor);
      signal.throwIfAborted();
      return work(trx);
    });
  })();
  pending.add(operation);
  void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  return probeWithSignal(() => operation, AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]));
}

/** Bounded shared health only; policy, owner identity, funds and admission are
 * never stored here. The acquisition transaction ends before budget or fetch. */
export function createSharedFundedProbeCache(input: {
  db: PlatformDB;
  now: () => Date;
  dbDeadlineMs?: number;
  reviewed?: boolean;
}) {
  const reviewed = input.reviewed === true;
  const dbDeadlineMs = Math.min(MAX_DB_DEADLINE_MS, Math.max(1, input.dbDeadlineMs ?? MAX_DB_DEADLINE_MS));
  async function readRow(db: PlatformDB, key: string): Promise<Row | undefined> {
    return (await sql<Row>`select lease_token, ready, checked_ms, stale_ms, price_expiry_ms
      from ai_funded_model_probe_cache where cache_key = ${key}`.execute(db.executor)).rows[0];
  }
  async function acquire(key: string, token: string, signal: AbortSignal): Promise<{
    row: Row | undefined; schedule?: ProbeSchedule;
  }> {
    return boundedDb(input.db, signal, dbDeadlineMs, async trx => {
      if (reviewed) {
        const cached = await readRow(trx, key);
        if (fresh(cached, input.now().getTime(), reviewed)) return { row: cached };
      }
      // Serialize only the bounded row-cap/lease admission, never provider I/O.
      await sql`select pg_advisory_xact_lock(70432918)`.execute(trx.executor);
      const observed = input.now().getTime();
      await sql`delete from ai_funded_model_probe_cache
        where coalesce(stale_ms, 0) <= ${observed} and lease_until <= statement_timestamp()
          and (regular_after_ms = 0 or regular_after_ms + ${REVIEWED_FUNDED_HEALTH_TTL_MS} <= ${observed})`
        .execute(trx.executor);
      const prior = reviewed
        ? (await sql<{ regular_after_ms: string | number; failure_streak: number }>`
            select regular_after_ms, failure_streak from ai_funded_model_probe_cache where cache_key = ${key} for update
          `.execute(trx.executor)).rows[0]
        : undefined;
      const previousRegularMs = Number(prior?.regular_after_ms ?? 0);
      const expedited = previousRegularMs > observed;
      // Claim a regular slot before dispatch. A crashed caller cannot immediately repeat it.
      const nextRegularMs = expedited ? previousRegularMs : observed + REVIEWED_FUNDED_HEALTH_TTL_MS;
      const regularMs = reviewed ? nextRegularMs : 0;
      const acquired = await sql<Row>`insert into ai_funded_model_probe_cache
          (cache_key, lease_token, lease_until, regular_after_ms)
        select ${key}, ${token}, statement_timestamp() + ${LEASE_MS} * interval '1 millisecond', ${regularMs}
        where (select count(*) from ai_funded_model_probe_cache) < ${MAX_ROWS}
          or exists (select 1 from ai_funded_model_probe_cache where cache_key = ${key})
        on conflict (cache_key) do update set lease_token = excluded.lease_token,
          lease_until = excluded.lease_until, ready = null, checked_ms = null, stale_ms = null, price_expiry_ms = null,
          regular_after_ms = excluded.regular_after_ms
        where ai_funded_model_probe_cache.lease_until <= statement_timestamp()
          and coalesce(ai_funded_model_probe_cache.stale_ms, 0) <= ${observed}
        returning lease_token, ready, checked_ms, stale_ms, price_expiry_ms`.execute(trx.executor);
      if (acquired.rows[0]) return {
        row: acquired.rows[0],
        schedule: reviewed ? { previousRegularMs, regularMs, expedited, failureStreak: prior?.failure_streak ?? 0 } : undefined,
      };
      return { row: await readRow(trx, key) };
    });
  }
  async function publish(key: string, token: string, result: FundedModelProbeResult, signal: AbortSignal,
    schedule?: ProbeSchedule, dispatched = false): Promise<FundedModelProbeResult | undefined> {
    const checked = Date.parse(result.checkedAt);
    let stale = Date.parse(result.staleAfter);
    let regularMs = schedule?.regularMs ?? 0;
    let failureStreak = schedule?.failureStreak ?? 0;
    if (result.ready) {
      failureStreak = 0;
    } else if (schedule && dispatched) {
      failureStreak = Math.min(failureStreak + 1, RETRY_BACKOFF_MS.length);
      stale = Math.max(checked + 1, Math.min(checked + RETRY_BACKOFF_MS[failureStreak - 1]!, regularMs));
    } else if (schedule?.expedited) {
      // The retry allowance can be full while this model's regular slot is still available later.
      stale = Math.max(checked + 1, Math.min(checked + REVIEWED_FUNDED_HEALTH_TTL_MS, regularMs));
    } else if (schedule) {
      regularMs = schedule.previousRegularMs;
    }
    return boundedDb(input.db, signal, dbDeadlineMs, async trx => {
      // Lease identity AND server expiry fence late/abandoned writers.
      const saved = await sql`update ai_funded_model_probe_cache set ready = ${result.ready},
        checked_ms = ${checked}, stale_ms = ${stale},
        price_expiry_ms = ${result.ready ? Date.parse(result.priceValidThrough ?? "") : null},
        regular_after_ms = ${regularMs}, failure_streak = ${failureStreak},
        lease_until = statement_timestamp()
        where cache_key = ${key} and lease_token = ${token} and lease_until > statement_timestamp()
        returning cache_key`.execute(trx.executor);
      return saved.rows.length === 1 ? { ...result, staleAfter: new Date(stale).toISOString() } : undefined;
    });
  }
  return {
    /** A paid request's definitive upstream failure only supersedes older healthy evidence. */
    async invalidate(key: string, observedMs: number, signal: AbortSignal): Promise<void> {
      await boundedDb(input.db, signal, dbDeadlineMs, async trx => {
        await sql`update ai_funded_model_probe_cache set ready = false,
          checked_ms = ${observedMs},
          stale_ms = greatest(${observedMs + 1}, least(regular_after_ms, ${observedMs + RETRY_BACKOFF_MS[0]})),
          price_expiry_ms = null
          where cache_key = ${key} and ready and checked_ms <= ${observedMs}
            and stale_ms > ${input.now().getTime()} and lease_until <= statement_timestamp()`
          .execute(trx.executor);
      });
    },
    /** SELECT only: no cleanup, lease acquisition, budget reservation or provider I/O. */
    async readCached(key: string, signal: AbortSignal, unavailable: () => FundedModelProbeResult): Promise<FundedModelProbeResult> {
      try {
        const row = await boundedDb(input.db, signal, dbDeadlineMs, trx => readRow(trx, key));
        signal.throwIfAborted();
        return fresh(row, input.now().getTime(), reviewed) ?? unavailable();
      } catch (error: unknown) {
        console.warn("[funded-ai] Cached model readiness unavailable:", error instanceof Error ? error.name : typeof error);
        return unavailable();
      }
    },
    async probe(key: string, signal: AbortSignal, run: (attempt?: SharedProbeAttempt) => Promise<FundedModelProbeResult>,
      unavailable: () => FundedModelProbeResult): Promise<FundedModelProbeResult> {
      const token = randomUUID();
      let owned = false;
      let schedule: ProbeSchedule | undefined;
      let dispatched = false;
      try {
        while (!signal.aborted) {
          const acquired = await acquire(key, token, signal);
          const { row } = acquired;
          owned = row?.lease_token === token;
          schedule = acquired.schedule;
          signal.throwIfAborted();
          if (owned) {
            const result = await run(schedule ? {
              expedited: schedule.expedited,
              recordDispatch() { dispatched = true; },
            } : undefined);
            signal.throwIfAborted();
            const saved = await publish(key, token, result, signal, schedule, dispatched);
            if (!saved) return unavailable();
            owned = false;
            return saved;
          }
          const cached = fresh(row, input.now().getTime(), reviewed);
          if (cached) return cached;
          if (!row) return unavailable(); // Bounded cache full: fail closed.
          await probeWithSignal(() => new Promise<void>(resolve => {
            const timer = setTimeout(done, 50);
            function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          }), signal);
        }
      } catch (error: unknown) {
        console.warn("[funded-ai] Shared model readiness unavailable:", error instanceof Error ? error.name : typeof error);
      } finally {
        if (owned) {
          // Publish a negative receipt after cancellation to keep the next replica from repeating a spent probe.
          try { await publish(key, token, unavailable(), AbortSignal.timeout(dbDeadlineMs), schedule, dispatched); }
          catch (error: unknown) {
            console.warn("[funded-ai] Shared probe lease cleanup failed:", error instanceof Error ? error.name : typeof error);
          }
        }
      }
      return unavailable();
    },
  };
}
