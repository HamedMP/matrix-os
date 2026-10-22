import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod/v4';
import { GoogleProcessingEnvelopeSchema } from './envelope.js';

const CLOCK_SKEW_MS = 5000;
const LIFETIME_MS = 30000;
const MAX_IN_FLIGHT = 64;
export class GoogleRequestLedgerError extends Error {
  constructor(readonly code: 'unavailable' | 'replay' | 'capacity' = 'unavailable') { super('Google data request unavailable'); this.name = 'GoogleRequestLedgerError'; }
}
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof GoogleRequestLedgerError) throw error;
    if (!(error instanceof z.ZodError)) console.warn('[google-data] Request ledger unavailable:', error instanceof Error ? error.name : 'UnknownError');
    throw new GoogleRequestLedgerError();
  }
}
/** Only consume a machine-signature-verified request after current policy and
 * live owner/run/runtime/generation checks. Structural validation and one-use
 * consumption do not provide any of those authorities or approve collection.
 * Signers must generate fresh UUIDs. Expired receipts are retained through skew;
 * their original envelopes remain invalid after bounded metadata deletion. */
export function createGoogleRequestLedger<DB>(db: Kysely<DB>, options: { now?: () => Date; maxRows?: number; maxRowsPerOwner?: number } = {}) {
  const budget = z.object({ total: z.number().int().min(1).max(100000), owner: z.number().int().min(1).max(1000) }).safeParse({
    total: options.maxRows ?? 100000, owner: options.maxRowsPerOwner ?? Math.min(options.maxRows ?? 100000, 1000),
  });
  if (!budget.success) throw new GoogleRequestLedgerError();
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<unknown> | undefined;
  let closed = false, active = 0;
  let idle: Promise<void> | undefined, resolveIdle: (() => void) | undefined;
  const locked = async <T>(work: (tx: Transaction<DB>) => Promise<T>) => {
    if (closed) throw new GoogleRequestLedgerError();
    if (active >= MAX_IN_FLIGHT) throw new GoogleRequestLedgerError('capacity');
    if (active++ === 0) idle = new Promise<void>(resolve => { resolveIdle = resolve; });
    try {
      return await db.transaction().execute(async tx => {
        await sql`SET LOCAL statement_timeout = '5s'`.execute(tx);
        await sql`SET LOCAL lock_timeout = '2s'`.execute(tx);
        // Serialize count, expired deletion and insert across all gateway instances.
        await sql`SELECT pg_advisory_xact_lock(5510357)`.execute(tx);
        return work(tx);
      });
    } finally { if (--active === 0) { resolveIdle!(); idle = undefined; resolveIdle = undefined; } }
  };
  const clock = () => {
    const at = now().getTime();
    if (!Number.isSafeInteger(at) || at < 0) throw new GoogleRequestLedgerError();
    return at;
  };
  const cleanup = () => guarded(() => locked(async tx => {
    const result = await sql`DELETE FROM google_processing_requests WHERE retained_until<=${new Date(clock())} RETURNING request_id`.execute(tx);
    return result.rows.length;
  }));
  return {
    async migrate() {
      await guarded(() => locked(async tx => {
        await sql`CREATE TABLE IF NOT EXISTS google_processing_requests (
          request_id UUID PRIMARY KEY,owner_id TEXT NOT NULL,claim_digest TEXT NOT NULL CHECK(claim_digest~'^[a-f0-9]{64}$'),
          consumed_at TIMESTAMPTZ NOT NULL,expires_at TIMESTAMPTZ NOT NULL,retained_until TIMESTAMPTZ NOT NULL)`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS google_processing_request_owner ON google_processing_requests(owner_id)`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS google_processing_request_expiry ON google_processing_requests(retained_until)`.execute(tx);
      }));
      await cleanup();
    },
    async consume(value: unknown): Promise<void> {
      return guarded(async () => {
        const envelope = GoogleProcessingEnvelopeSchema.parse(value);
        const digest = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
        const assertCurrent = () => {
          const at = clock(), policyExpiry = Date.parse(envelope.policyExpiresAt);
          if (!Number.isFinite(policyExpiry) || envelope.issuedAt > at + CLOCK_SKEW_MS || envelope.expiresAt <= at
            || envelope.expiresAt <= envelope.issuedAt || envelope.expiresAt - envelope.issuedAt > LIFETIME_MS
            || envelope.expiresAt > policyExpiry || envelope.expiresAt > Date.parse(envelope.collectionExpiresAt)) throw new GoogleRequestLedgerError();
          return at;
        };
        await locked(async tx => {
          // Queue/lock wait time never extends a signed request's authority.
          const at = assertCurrent();
          await sql`DELETE FROM google_processing_requests WHERE retained_until<=${new Date(at)}`.execute(tx);
          const counts = await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=${envelope.ownerId})::int AS owned FROM google_processing_requests`.execute(tx);
          if (counts.rows[0]!.total >= budget.data.total || counts.rows[0]!.owned >= budget.data.owner) throw new GoogleRequestLedgerError('capacity');
          const result = await sql`INSERT INTO google_processing_requests(request_id,owner_id,claim_digest,consumed_at,expires_at,retained_until)
            VALUES(${envelope.requestId},${envelope.ownerId},${digest},${new Date(at)},${new Date(envelope.expiresAt)},${new Date(envelope.expiresAt + CLOCK_SKEW_MS)})
            ON CONFLICT(request_id) DO NOTHING RETURNING request_id`.execute(tx);
          if (!result.rows.length) throw new GoogleRequestLedgerError('replay');
        });
        // A commit may outlive the envelope. Its receipt stays consumed, but the
        // caller must receive a refusal and cannot proceed to collection.
        assertCurrent();
      });
    },
    cleanup,
    startCleanup() {
      if (timer || closed) return;
      timer = setInterval(() => {
        if (!sweeping) sweeping = cleanup().catch(error => console.warn('[google-data] Request cleanup unavailable:', error instanceof Error ? error.name : 'UnknownError')).finally(() => { sweeping = undefined; });
      }, 60000);
      timer.unref();
    },
    async close() { closed = true; if (timer) clearInterval(timer); timer = undefined; await Promise.all([sweeping, idle]); },
  };
}
export type GoogleRequestLedger = ReturnType<typeof createGoogleRequestLedger>;
