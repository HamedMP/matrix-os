import { sql, type Kysely } from 'kysely';
import { z } from 'zod/v4';
import { GoogleDataStampSchema } from '../profiles.js';
import { boundedProvenanceTransaction } from '../provenance/transaction.js';
import { GooglePolicyBindingSchema } from './profile-resolution.js';
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/);
const keySchema = GooglePolicyBindingSchema.omit({ accessSourceId: true }).extend({ ownerId: reference, chatId: reference }).strip();
const pinSchema = keySchema.extend({ identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  originIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(32), stamps: z.array(GoogleDataStampSchema).min(1).max(32) }).strict()
  .refine(value => new Set(value.originIds).size === value.originIds.length && value.stamps.every(s => s.ownerId === value.ownerId && s.dataKinds.includes('google-derived-context'))
    && new Set(value.stamps.map(s => JSON.stringify([s.googleAccountId, s.purposeId]))).size === value.stamps.length);
export type GoogleRunPinKey = z.infer<typeof keySchema>;
export type GoogleRunPinInput = z.infer<typeof pinSchema>;
export interface GoogleRunPin extends GoogleRunPinInput { createdAt: string; expiresAt: string; retireAt: string }
export class GoogleRunPinError extends Error { constructor() { super('Google run policy unavailable'); this.name = 'GoogleRunPinError'; } }
interface PinRow { payload: unknown; created_at: Date; expires_at: Date; retire_at: Date }
const project = (row: PinRow): GoogleRunPin => ({ ...pinSchema.parse(row.payload), createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), retireAt: row.retire_at.toISOString() });
const deny = (): never => { throw new GoogleRunPinError(); };
const normalized = (value: GoogleRunPinInput): GoogleRunPinInput => ({ ...value, originIds: [...value.originIds].sort(),
  stamps: [...value.stamps].sort((a, b) => JSON.stringify([a.googleAccountId, a.purposeId]).localeCompare(JSON.stringify([b.googleAccountId, b.purposeId]))) });

/** Durable identity latch, NEVER an approval cache. Host registry guarantees a fresh run/generation
 * after at most 20 minutes; policy expiry never removes a latch early and permits silent replacement.
 * Host owns migration/startCleanup/close ordering and the injected pool. No content or credentials. */
export function createGoogleRunPinStore<DB>(db: Kysely<DB>, options: { maxPins?: number; maxPinsPerOwner?: number } = {}) {
  const totalCap = options.maxPins ?? 4096; const ownerCap = options.maxPinsPerOwner ?? 64;
  if (![totalCap, ownerCap].every(Number.isSafeInteger) || totalCap < 1 || totalCap > 4096 || ownerCap < 1 || ownerCap > 64) deny();
  let closed = false; let timer: ReturnType<typeof setInterval> | undefined; let sweeping: Promise<unknown> | undefined;
  const active = () => { if (closed) deny(); };
  async function cleanup() {
    active();
    return boundedProvenanceTransaction(db, async tx => {
      const result = await sql`DELETE FROM google_runtime_policy_pins WHERE ctid IN
        (SELECT ctid FROM google_runtime_policy_pins WHERE retire_at <= clock_timestamp() ORDER BY retire_at LIMIT 200) RETURNING run_id`.execute(tx);
      return result.rows.length;
    });
  }
  return {
    async migrate() {
      active();
      await boundedProvenanceTransaction(db, async tx => {
        await sql`SELECT pg_advisory_xact_lock(551035505)`.execute(tx);
        await sql`CREATE TABLE IF NOT EXISTS google_runtime_policy_pins (
          owner_id TEXT NOT NULL, chat_id TEXT NOT NULL, run_id TEXT NOT NULL, runtime_handle TEXT NOT NULL, execution_generation TEXT NOT NULL,
          payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, retire_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY(owner_id,runtime_handle,execution_generation,run_id), CHECK(retire_at <= created_at+interval '20 minutes'))`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS google_runtime_pin_retirement ON google_runtime_policy_pins(retire_at)`.execute(tx);
      });
    },
    async get(value: GoogleRunPinKey): Promise<GoogleRunPin | null> {
      active(); const key = keySchema.parse(value);
      return boundedProvenanceTransaction(db, async tx => {
        const row = (await sql<PinRow>`SELECT payload,created_at,expires_at,retire_at FROM google_runtime_policy_pins
          WHERE owner_id=${key.ownerId} AND chat_id=${key.chatId} AND run_id=${key.runId} AND runtime_handle=${key.runtimeHandle}
          AND execution_generation=${key.executionGeneration}`.execute(tx)).rows[0];
        return row ? project(row) : null;
      });
    },
    async latch(value: GoogleRunPinInput): Promise<GoogleRunPin> {
      active(); const input = normalized(pinSchema.parse(value));
      return boundedProvenanceTransaction(db, async tx => {
        await sql`SELECT pg_advisory_xact_lock(551035505)`.execute(tx);
        const at = Date.now(); const expires = new Date(Math.min(...input.stamps.map(s => Date.parse(s.expiresAt))));
        if (expires.getTime() <= at) deny();
        const row = (await sql<PinRow>`SELECT payload,created_at,expires_at,retire_at FROM google_runtime_policy_pins
          WHERE owner_id=${input.ownerId} AND runtime_handle=${input.runtimeHandle} AND execution_generation=${input.executionGeneration}
          AND run_id=${input.runId} FOR UPDATE`.execute(tx)).rows[0];
        if (row) {
          const existing = project(row);
          const { createdAt: _created, expiresAt: _expires, retireAt: _retire, ...existingInput } = existing;
          if (row.expires_at.getTime() <= Date.now() || row.retire_at.getTime() <= Date.now()
            || JSON.stringify(normalized(pinSchema.parse(existingInput))) !== JSON.stringify(input)) deny();
          return existing;
        }
        const counts = (await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=${input.ownerId})::int AS owned FROM google_runtime_policy_pins`.execute(tx)).rows[0]!;
        if (counts.total >= totalCap || counts.owned >= ownerCap) deny();
        const inserted = (await sql<PinRow>`INSERT INTO google_runtime_policy_pins(owner_id,chat_id,run_id,runtime_handle,execution_generation,payload,created_at,expires_at,retire_at)
          SELECT ${input.ownerId},${input.chatId},${input.runId},${input.runtimeHandle},${input.executionGeneration},${JSON.stringify(input)}::jsonb,
          statement_timestamp(),${expires},statement_timestamp()+interval '20 minutes' WHERE ${expires}::timestamptz > clock_timestamp()
          ON CONFLICT DO NOTHING RETURNING payload,created_at,expires_at,retire_at`.execute(tx)).rows[0];
        if (!inserted) deny(); return project(inserted);
      });
    },
    cleanup,
    startCleanup() {
      active(); if (timer) return;
      timer = setInterval(() => { if (!sweeping) sweeping = cleanup().catch(error => console.warn('[google-data] Run pin cleanup unavailable:', error instanceof Error ? error.name : 'UnknownError')).finally(() => { sweeping = undefined; }); }, 30000);
      timer.unref();
    },
    async close() { if (timer) clearInterval(timer); timer = undefined; closed = true; await sweeping; },
  };
}
export type GoogleRunPinStore = ReturnType<typeof createGoogleRunPinStore>;
