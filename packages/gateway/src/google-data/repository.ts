import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { z } from 'zod/v4';
import { migrateGooglePurgeDelivery,queueGooglePurgeConsents,type PurgeConsentRow } from './purge-delivery/store.js';
import { GoogleDataAuthorityError, GoogleDataConsentInputSchema, GoogleDataProfileInputSchema, type GoogleDataConsentInput, type GoogleDataProfileInput } from './profiles.js';

export interface ReviewedGoogleProfile { id: string; revision: number; status: 'reviewed' | 'revoked'; input: GoogleDataProfileInput }
export interface RecordedGoogleConsent { id: string; revision: number; status: 'active' | 'revoked'; input: GoogleDataConsentInput }
export type GoogleConsentKey = Pick<GoogleDataConsentInput, 'ownerId' | 'googleAccountId' | 'purposeId' | 'profileId'>;
const keySchema = GoogleDataConsentInputSchema.pick({ ownerId: true, googleAccountId: true, purposeId: true, profileId: true });
const expectedSchema = z.number().int().min(0).max(2_147_483_645);
const RETAIN_MS = 7 * 86400_000;
type ProfileRow = { id: string; revision: number; status: 'reviewed' | 'revoked'; payload: unknown };
type ConsentRow = { id: string; revision: number; status: 'active' | 'revoked'; payload: unknown };
function profile(row: ProfileRow | undefined): ReviewedGoogleProfile | null {
  return row ? { id: row.id, revision: row.revision, status: row.status, input: GoogleDataProfileInputSchema.parse(row.payload) } : null;
}
function consent(row: ConsentRow | undefined): RecordedGoogleConsent | null {
  return row ? { id: row.id, revision: row.revision, status: row.status, input: GoogleDataConsentInputSchema.parse(row.payload) } : null;
}
function current(value: ReviewedGoogleProfile | null, at: Date): value is ReviewedGoogleProfile {
  return Boolean(value && value.status === 'reviewed' && Date.parse(value.input.evidence.reviewedAt) <= at.getTime() && Date.parse(value.input.evidence.expiresAt) > at.getTime());
}
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof GoogleDataAuthorityError) throw error;
    if (!(error instanceof z.ZodError)) console.warn('[google-data] Registry unavailable:', error instanceof Error ? 'operation_failed' : 'untyped_failure');
    throw new GoogleDataAuthorityError();
  }
}
/** Server-only registry. Composition authenticates operators/owners; no client approval API exists here. */
export function createGoogleDataRepository<DB>(db: Kysely<DB>, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<unknown> | undefined;
  const locked = <T>(work: (tx: Kysely<DB>) => Promise<T>) => {
    const execute=async(tx:Kysely<DB>)=>{
      await sql`SET LOCAL statement_timeout = '5s'`.execute(tx);
      await sql`SET LOCAL lock_timeout = '2s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(5510356)`.execute(tx);
      return work(tx);
    };
    return db.isTransaction ? execute(db) : db.transaction().execute(execute);
  };
  const queueMatching=async(tx:Kysely<DB>,where:RawBuilder<unknown>)=>{
    const rows=(await sql<PurgeConsentRow>`SELECT id,owner_id,google_account_id FROM google_data_consents WHERE ${where} ORDER BY id LIMIT 1001`.execute(tx)).rows;
    if(rows.length>1000) throw new GoogleDataAuthorityError('capacity');
    await queueGooglePurgeConsents(tx,rows);
  };
  const cleanup = (at = now()) => guarded(() => locked(async tx => {
    const cutoff = new Date(at.getTime() - RETAIN_MS);
    // Reap already eligible ACKs before capacity admission; pending commands never expire.
    const reapAcknowledged=()=>sql`DELETE FROM google_data_purge_commands WHERE id IN (SELECT d.id FROM google_data_purge_commands d
      WHERE d.state='acked' AND d.acked_at<=${cutoff}
      AND NOT EXISTS(SELECT 1 FROM google_data_consents c WHERE c.id=d.consent_id) ORDER BY d.acked_at,d.id LIMIT 100)`.execute(tx);
    await reapAcknowledged();
    // Full owners retain invalid authority rows for retry while other owners advance.
    // Registry locking makes the bounded per-owner/global admission and insert atomic.
    const invalid=(await sql<PurgeConsentRow>`WITH candidates AS (
      SELECT c.id,c.owner_id,c.google_account_id,row_number() OVER(PARTITION BY c.owner_id ORDER BY c.id) AS position
      FROM google_data_consents c JOIN google_data_profiles p ON p.id=c.profile_id
      WHERE (c.status='revoked' OR p.status='revoked' OR c.expires_at<=${at} OR p.expires_at<=${at})
      AND NOT EXISTS(SELECT 1 FROM google_data_purge_commands d WHERE d.consent_id=c.id)
    ), counts AS (SELECT owner_id,count(*) AS owned FROM google_data_purge_commands GROUP BY owner_id)
    SELECT c.id,c.owner_id,c.google_account_id FROM candidates c LEFT JOIN counts d ON d.owner_id=c.owner_id
      WHERE c.position<=GREATEST(0,1000-COALESCE(d.owned,0)) ORDER BY c.id
      LIMIT LEAST(1000,GREATEST(0,100000-(SELECT count(*) FROM google_data_purge_commands)))`.execute(tx)).rows;
    await queueGooglePurgeConsents(tx,invalid);
    // Match snapshot's profile -> consent order before deleting either relation.
    await sql`WITH aged_consents AS (
      SELECT c.profile_id FROM google_data_consents c JOIN google_data_profiles p ON p.id=c.profile_id
      WHERE (COALESCE(c.invalidated_at,c.expires_at)<=${cutoff} OR COALESCE(p.invalidated_at,p.expires_at)<=${cutoff})
      AND EXISTS(SELECT 1 FROM google_data_purge_commands d WHERE d.consent_id=c.id) ORDER BY c.id LIMIT 1000
    ), empty_profiles AS (SELECT p.id FROM google_data_profiles p WHERE COALESCE(p.invalidated_at,p.expires_at)<=${cutoff}
      AND NOT EXISTS(SELECT 1 FROM google_data_consents c WHERE c.profile_id=p.id) ORDER BY p.id LIMIT 1000)
    SELECT p.id FROM google_data_profiles p WHERE p.id IN (SELECT profile_id FROM aged_consents UNION SELECT id FROM empty_profiles)
      ORDER BY p.id FOR UPDATE`.execute(tx);
    const removed=await sql`DELETE FROM google_data_consents WHERE id IN (SELECT c.id FROM google_data_consents c
      JOIN google_data_profiles p ON p.id=c.profile_id
      WHERE (COALESCE(c.invalidated_at,c.expires_at)<=${cutoff} OR COALESCE(p.invalidated_at,p.expires_at)<=${cutoff})
      AND EXISTS(SELECT 1 FROM google_data_purge_commands d WHERE d.consent_id=c.id) ORDER BY c.id LIMIT 1000) RETURNING id`.execute(tx);
    const profiles=await sql`DELETE FROM google_data_profiles WHERE id IN (SELECT p.id FROM google_data_profiles p
      WHERE COALESCE(p.invalidated_at,p.expires_at)<=${cutoff}
      AND NOT EXISTS(SELECT 1 FROM google_data_consents c WHERE c.profile_id=p.id) ORDER BY p.id LIMIT 1000) RETURNING id`.execute(tx);
    // Never expire pending delivery or permit a still-present consent to be requeued after ACK cleanup.
    await reapAcknowledged();
    return {consents:removed.rows.length,profiles:profiles.rows.length};
  }));
  return {
    async migrate() {
      await guarded(() => locked(async tx => {
        await sql`CREATE TABLE IF NOT EXISTS google_data_profiles (
          id UUID PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
          status TEXT NOT NULL CHECK(status IN ('reviewed','revoked')),payload JSONB NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,invalidated_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL)`.execute(tx);
        await sql`CREATE TABLE IF NOT EXISTS google_data_consents (
          id UUID UNIQUE NOT NULL,owner_id TEXT NOT NULL,google_account_id UUID NOT NULL,purpose_id TEXT NOT NULL,
          profile_id UUID NOT NULL REFERENCES google_data_profiles(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK(revision>0),status TEXT NOT NULL CHECK(status IN ('active','revoked')),
          payload JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL,invalidated_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY(owner_id,google_account_id,purpose_id,profile_id))`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS google_data_profile_owner ON google_data_profiles(owner_id)`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS google_data_profile_expiry ON google_data_profiles(expires_at)`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS google_data_consent_expiry ON google_data_consents(expires_at)`.execute(tx);
        await migrateGooglePurgeDelivery(tx);
      }));
      await cleanup();
    },
    async reviewProfile(value: unknown, expectedRevision: number): Promise<ReviewedGoogleProfile> {
      return guarded(async () => {
        expectedSchema.parse(expectedRevision);
        const record = z.record(z.string(), z.unknown()).parse(value);
        const { id: rawId, ...body } = record;
        const input = GoogleDataProfileInputSchema.parse(body);
        if ((expectedRevision === 0) !== (rawId === undefined)) throw new GoogleDataAuthorityError('conflict');
        const id = rawId === undefined ? randomUUID() : z.uuid().parse(rawId);
        return locked(async tx => {
          const at = now();
          if (Date.parse(input.evidence.reviewedAt) > at.getTime() || Date.parse(input.evidence.expiresAt) <= at.getTime()
            || Date.parse(input.evidence.expiresAt) > at.getTime() + 365 * 86400_000) throw new GoogleDataAuthorityError();
          if (expectedRevision === 0) {
            const counts = await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=${input.ownerId})::int AS owned FROM google_data_profiles`.execute(tx);
            if (counts.rows[0]!.total >= 10000 || counts.rows[0]!.owned >= 100) throw new GoogleDataAuthorityError('capacity');
            const result = await sql<ProfileRow>`INSERT INTO google_data_profiles(id,owner_id,revision,status,payload,expires_at,updated_at)
              VALUES(${id},${input.ownerId},1,'reviewed',${JSON.stringify(input)}::jsonb,${new Date(input.evidence.expiresAt)},${at})
              ON CONFLICT(id) DO NOTHING RETURNING *`.execute(tx);
            if (!result.rows.length) throw new GoogleDataAuthorityError('conflict');
            return profile(result.rows[0])!;
          }
          await queueMatching(tx,sql`owner_id=${input.ownerId} AND profile_id=${id}`);
          const result = await sql<ProfileRow>`UPDATE google_data_profiles SET revision=revision+1,status='reviewed',payload=${JSON.stringify(input)}::jsonb,
            expires_at=${new Date(input.evidence.expiresAt)},invalidated_at=NULL,updated_at=${at}
            WHERE id=${id} AND owner_id=${input.ownerId} AND revision=${expectedRevision} RETURNING *`.execute(tx);
          if (!result.rows.length) throw new GoogleDataAuthorityError('conflict');
          return profile(result.rows[0])!;
        });
      });
    },
    async recordConsent(value: unknown, expectedRevision: number): Promise<RecordedGoogleConsent> {
      return guarded(async () => {
        const input = GoogleDataConsentInputSchema.parse(value); expectedSchema.parse(expectedRevision);
        return locked(async tx => {
          const row = profile((await sql<ProfileRow>`SELECT * FROM google_data_profiles WHERE id=${input.profileId} AND owner_id=${input.ownerId} FOR UPDATE`.execute(tx)).rows[0]);
          const at = now();
          if (!current(row, at) || row.revision !== input.profileRevision || row.input.evidence.revision !== input.evidenceRevision
            || row.input.disclosure.revision !== input.disclosureRevision || row.input.retention.revision !== input.retentionRevision
            || row.input.purposeId !== input.purposeId || input.dataKinds.some(kind => !row.input.dataKinds.includes(kind))
            || Date.parse(input.expiresAt) <= at.getTime() || Date.parse(input.expiresAt) > Math.min(Date.parse(row.input.evidence.expiresAt), at.getTime() + 30 * 86400_000)) throw new GoogleDataAuthorityError('conflict');
          const id = randomUUID();
          if (expectedRevision === 0) {
            const counts = await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=${input.ownerId})::int AS owned FROM google_data_consents`.execute(tx);
            if (counts.rows[0]!.total >= 100000 || counts.rows[0]!.owned >= 1000) throw new GoogleDataAuthorityError('capacity');
            const result = await sql<ConsentRow>`INSERT INTO google_data_consents(id,owner_id,google_account_id,purpose_id,profile_id,revision,status,payload,expires_at,updated_at)
              VALUES(${id},${input.ownerId},${input.googleAccountId},${input.purposeId},${input.profileId},1,'active',${JSON.stringify(input)}::jsonb,${new Date(input.expiresAt)},${at})
              ON CONFLICT(owner_id,google_account_id,purpose_id,profile_id) DO NOTHING RETURNING *`.execute(tx);
            if (!result.rows.length) throw new GoogleDataAuthorityError('conflict');
            return consent(result.rows[0])!;
          }
          await queueMatching(tx,sql`owner_id=${input.ownerId} AND google_account_id=${input.googleAccountId} AND purpose_id=${input.purposeId} AND profile_id=${input.profileId}`);
          const result = await sql<ConsentRow>`UPDATE google_data_consents SET id=${id},revision=revision+1,status='active',payload=${JSON.stringify(input)}::jsonb,
            expires_at=${new Date(input.expiresAt)},invalidated_at=NULL,updated_at=${at}
            WHERE owner_id=${input.ownerId} AND google_account_id=${input.googleAccountId} AND purpose_id=${input.purposeId} AND profile_id=${input.profileId} AND revision=${expectedRevision} RETURNING *`.execute(tx);
          if (!result.rows.length) throw new GoogleDataAuthorityError('conflict');
          return consent(result.rows[0])!;
        });
      });
    },
    async revokeProfile(id: string, ownerId: string, expectedRevision: number) {
      return guarded(() => locked(async tx => {
        z.uuid().parse(id); keySchema.shape.ownerId.parse(ownerId); expectedSchema.parse(expectedRevision);
        await queueMatching(tx,sql`owner_id=${ownerId} AND profile_id=${id}`);
        const result = await sql`UPDATE google_data_profiles SET revision=revision+1,status='revoked',invalidated_at=${now()},updated_at=${now()}
          WHERE id=${id} AND owner_id=${ownerId} AND revision=${expectedRevision} RETURNING revision`.execute(tx);
        if (!result.rows.length) throw new GoogleDataAuthorityError('conflict');
        return expectedRevision + 1;
      }));
    },
    async revokeConsent(value: unknown, expectedRevision: number) {
      return guarded(() => locked(async tx => {
        const key = keySchema.parse(value); expectedSchema.parse(expectedRevision);
        await queueMatching(tx,sql`owner_id=${key.ownerId} AND google_account_id=${key.googleAccountId} AND purpose_id=${key.purposeId} AND profile_id=${key.profileId}`);
        const result = await sql`UPDATE google_data_consents SET revision=revision+1,status='revoked',invalidated_at=${now()},updated_at=${now()}
          WHERE owner_id=${key.ownerId} AND google_account_id=${key.googleAccountId} AND purpose_id=${key.purposeId} AND profile_id=${key.profileId} AND revision=${expectedRevision} RETURNING revision`.execute(tx);
        if (!result.rows.length) throw new GoogleDataAuthorityError('conflict');
        return expectedRevision + 1;
      }));
    },
    async revokeAccount(ownerId: string, googleAccountId: string) {
      return guarded(() => locked(async tx => {
        keySchema.shape.ownerId.parse(ownerId); z.uuid().parse(googleAccountId);
        await queueMatching(tx,sql`owner_id=${ownerId} AND google_account_id=${googleAccountId}`);
        const result = await sql`UPDATE google_data_consents SET revision=revision+1,status='revoked',invalidated_at=${now()},updated_at=${now()}
          WHERE owner_id=${ownerId} AND google_account_id=${googleAccountId} AND status='active' RETURNING id`.execute(tx);
        return result.rows.length;
      }));
    },
    async deleteOwner(ownerId: string) {
      return guarded(() => locked(async tx => { keySchema.shape.ownerId.parse(ownerId);
        await queueMatching(tx,sql`owner_id=${ownerId}`);
        return (await sql`DELETE FROM google_data_profiles WHERE owner_id=${ownerId} RETURNING id`.execute(tx)).rows.length;
      }));
    },
    /** Bounded server-only discovery; callers still resolve and compare every route field. */
    async listReviewedProfiles(ownerId: string): Promise<ReviewedGoogleProfile[]> {
      return guarded(async () => {
        keySchema.shape.ownerId.parse(ownerId);
        const at = now();
        const rows = await sql<ProfileRow>`SELECT * FROM google_data_profiles WHERE owner_id=${ownerId} AND status='reviewed' AND expires_at>${at} ORDER BY id LIMIT 101`.execute(db);
        if (rows.rows.length > 100) throw new GoogleDataAuthorityError('capacity');
        return rows.rows.map(row => profile(row)!).filter(row => current(row, at));
      });
    },
    async snapshot(value: GoogleConsentKey) {
      return guarded(() => db.transaction().execute(async tx => {
        const key = keySchema.parse(value);
        await sql`SET LOCAL statement_timeout = '5s'`.execute(tx);
        await sql`SET LOCAL lock_timeout = '2s'`.execute(tx);
        const reviewed = profile((await sql<ProfileRow>`SELECT * FROM google_data_profiles WHERE id=${key.profileId} AND owner_id=${key.ownerId} FOR SHARE`.execute(tx)).rows[0]);
        const recorded = reviewed ? consent((await sql<ConsentRow>`SELECT * FROM google_data_consents WHERE owner_id=${key.ownerId} AND google_account_id=${key.googleAccountId} AND purpose_id=${key.purposeId} AND profile_id=${key.profileId} FOR SHARE`.execute(tx)).rows[0]) : null;
        return { profile: reviewed, consent: recorded };
      }));
    },
    cleanup,
    startCleanup() {
      if (timer) return;
      timer = setInterval(() => {
        if (!sweeping) sweeping = cleanup().catch(error => console.warn('[google-data] Cleanup unavailable:', error instanceof Error ? 'operation_failed' : 'untyped_failure')).finally(() => { sweeping = undefined; });
      }, 300000);
      timer.unref();
    },
    async close() { if (timer) clearInterval(timer); timer = undefined; await sweeping; },
  };
}
export type GoogleDataRepository = ReturnType<typeof createGoogleDataRepository>;
