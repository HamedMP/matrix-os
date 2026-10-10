import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { PlatformDB } from "./db.js";
import type { FundedModelProbeResult } from "./ai-funded-model-probes.js";
import { probeWithSignal } from "./ai-funded-jev-probe.js";

const MAX_ROWS = 128;
const MAX_PENDING_DB = 64;
const LEASE_MS = 14_000;
export const SHARED_FUNDED_HEALTH_TTL_MS = 300_000;
const NEGATIVE_TTL_MS = 5_000;
const pending = new Set<Promise<unknown>>();
interface Row {
  lease_token: string;
  ready: boolean | null;
  checked_ms: number | string | null;
  stale_ms: number | string | null;
  price_expiry_ms: number | string | null;
}

/** Only the digest is stored. A changed Relay origin, credential or local probe
 * configuration cannot reuse another deployment's health receipt. */
export function fundedProbeCacheKey(input: {
  modelId: string; relayOrigin: string; controlToken: string; dailyLimit: number; minuteLimit: number;
}): string {
  return createHash("sha256").update(JSON.stringify(["priced-readiness-v1", input.modelId,
    input.relayOrigin, input.controlToken, input.dailyLimit, input.minuteLimit])).digest("hex");
}

function fresh(row: Row | undefined, nowMs: number): FundedModelProbeResult | undefined {
  if (!row || row.ready === null) return undefined;
  const checked = Number(row.checked_ms), stale = Number(row.stale_ms);
  const price = Number(row.price_expiry_ms);
  if (!Number.isSafeInteger(checked) || !Number.isSafeInteger(stale)
    || checked > nowMs || stale <= nowMs || stale <= checked
    || stale - checked > (row.ready ? SHARED_FUNDED_HEALTH_TTL_MS : NEGATIVE_TTL_MS)
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
export function createSharedFundedProbeCache(input: { db: PlatformDB; now: () => Date; dbDeadlineMs?: number }) {
  const dbDeadlineMs = Math.min(1_500, Math.max(1, input.dbDeadlineMs ?? 1_500));
  async function acquire(key: string, token: string, signal: AbortSignal): Promise<Row | undefined> {
    return boundedDb(input.db, signal, dbDeadlineMs, async trx => {
      // Serialize only the bounded row-cap/lease admission, never provider I/O.
      await sql`select pg_advisory_xact_lock(70432918)`.execute(trx.executor);
      const observed = input.now().getTime();
      await sql`delete from ai_funded_model_probe_cache
        where coalesce(stale_ms, 0) <= ${observed} and lease_until <= statement_timestamp()`
        .execute(trx.executor);
      const acquired = await sql<Row>`insert into ai_funded_model_probe_cache
          (cache_key, lease_token, lease_until)
        select ${key}, ${token}, statement_timestamp() + ${LEASE_MS} * interval '1 millisecond'
        where (select count(*) from ai_funded_model_probe_cache) < ${MAX_ROWS}
          or exists (select 1 from ai_funded_model_probe_cache where cache_key = ${key})
        on conflict (cache_key) do update set lease_token = excluded.lease_token,
          lease_until = excluded.lease_until, ready = null, checked_ms = null, stale_ms = null, price_expiry_ms = null
        where ai_funded_model_probe_cache.lease_until <= statement_timestamp()
          and coalesce(ai_funded_model_probe_cache.stale_ms, 0) <= ${observed}
        returning lease_token, ready, checked_ms, stale_ms, price_expiry_ms`.execute(trx.executor);
      if (acquired.rows[0]) return acquired.rows[0];
      const existing = await sql<Row>`select lease_token, ready, checked_ms, stale_ms, price_expiry_ms
        from ai_funded_model_probe_cache where cache_key = ${key}`.execute(trx.executor);
      return existing.rows[0];
    });
  }
  async function publish(key: string, token: string, result: FundedModelProbeResult, signal: AbortSignal): Promise<boolean> {
    return boundedDb(input.db, signal, dbDeadlineMs, async trx => {
      // Lease identity AND server expiry fence late/abandoned writers.
      const saved = await sql`update ai_funded_model_probe_cache set ready = ${result.ready},
        checked_ms = ${Date.parse(result.checkedAt)}, stale_ms = ${Date.parse(result.staleAfter)},
        price_expiry_ms = ${result.ready ? Date.parse(result.priceValidThrough ?? "") : null},
        lease_until = statement_timestamp()
        where cache_key = ${key} and lease_token = ${token} and lease_until > statement_timestamp()
        returning cache_key`.execute(trx.executor);
      return saved.rows.length === 1;
    });
  }
  return {
    /** SELECT only: no cleanup, lease acquisition, budget reservation or provider I/O. */
    async readCached(key: string, signal: AbortSignal, unavailable: () => FundedModelProbeResult): Promise<FundedModelProbeResult> {
      try {
        const row = await boundedDb(input.db, signal, dbDeadlineMs, async trx =>
          (await sql<Row>`select lease_token, ready, checked_ms, stale_ms, price_expiry_ms
            from ai_funded_model_probe_cache where cache_key = ${key}`.execute(trx.executor)).rows[0]);
        signal.throwIfAborted();
        return fresh(row, input.now().getTime()) ?? unavailable();
      } catch (error: unknown) {
        console.warn("[funded-ai] Cached model readiness unavailable:", error instanceof Error ? error.name : typeof error);
        return unavailable();
      }
    },
    async probe(key: string, signal: AbortSignal, run: () => Promise<FundedModelProbeResult>,
      unavailable: () => FundedModelProbeResult): Promise<FundedModelProbeResult> {
      const token = randomUUID();
      let owned = false;
      try {
        while (!signal.aborted) {
          const row = await acquire(key, token, signal);
          signal.throwIfAborted();
          const cached = fresh(row, input.now().getTime());
          if (cached) return cached;
          if (!row) return unavailable(); // Bounded cache full: fail closed.
          if (row.lease_token === token) {
            owned = true;
            const result = await run();
            signal.throwIfAborted();
            if (!await publish(key, token, result, signal)) return unavailable();
            owned = false;
            return result;
          }
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
          // Preserve a short negative receipt after cancellation, rather than
          // inviting another replica to immediately repeat a spent probe.
          try { await publish(key, token, unavailable(), AbortSignal.timeout(dbDeadlineMs)); }
          catch (error: unknown) {
            console.warn("[funded-ai] Shared probe lease cleanup failed:", error instanceof Error ? error.name : typeof error);
          }
        }
      }
      return unavailable();
    },
  };
}
