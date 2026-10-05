import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction, type Selectable } from 'kysely';
import { z } from 'zod/v4';
import type { AccountDeletionJobsTable, PlatformDatabase } from '../db.js';
import { ACCOUNT_DELETION_GRACE_MS, type AccountDeletionContext } from './types.js';

const contextSchema = z.object({
  clerkUserId: z.string().min(1).max(128),
  appleRevocationUnknown: z.boolean().optional(),
  appleRevocationPrepared: z.boolean().optional(),
  appleTokens: z.array(z.object({ clientId: z.string().min(1).max(256), token: z.string().min(1).max(16384), tokenType: z.enum(['access_token', 'refresh_token']) })).max(16),
});
export function hashAccountDeletionOwner(owner: string, secret: string): string {
  const key = createHash('sha256').update('account-deletion-owner\0').update(secret).digest();
  return createHmac('sha256', key).update(owner).digest('hex');
}
export async function lockAccountDeletionOwner(db: Kysely<PlatformDatabase> | Transaction<PlatformDatabase>, ownerHash: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'account-deletion:' + ownerHash}, 0))`.execute(db);
}
export type DeletionJob = Selectable<AccountDeletionJobsTable>;
export class AccountDeletionConflictError extends Error {
  constructor() { super('Account deletion can no longer be cancelled.'); this.name = 'AccountDeletionConflictError'; }
}

/** This wrapper never closes its injected Kysely pool. */
export class AccountDeletionRepository {
  private readonly key: Buffer;
  private readonly hashKey: Buffer;
  private readonly now: () => Date;
  constructor(private readonly db: Kysely<PlatformDatabase>, options: { secret: string; now?: () => Date }) {
    if (Buffer.byteLength(options.secret) < 32) throw new Error('Account deletion encryption is not configured.');
    this.key = createHash('sha256').update('account-deletion-encryption\0').update(options.secret).digest();
    this.hashKey = createHash('sha256').update('account-deletion-owner\0').update(options.secret).digest();
    this.now = options.now ?? (() => new Date());
  }
  ownerHash(owner: string): string { return createHmac('sha256', this.hashKey).update(owner).digest('hex'); }
  private encrypt(context: AccountDeletionContext, ownerHash: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(ownerHash));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(contextSchema.parse(context)), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  decrypt(job: DeletionJob): AccountDeletionContext {
    if (!job.encrypted_context) throw new Error('Deletion context is unavailable.');
    const bytes = Buffer.from(job.encrypted_context, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(job.owner_hash));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return contextSchema.parse(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')));
  }
  get(owner: string): Promise<DeletionJob | undefined> {
    return this.db.selectFrom('account_deletion_jobs').selectAll().where('owner_hash', '=', this.ownerHash(owner)).executeTakeFirst();
  }
  async accept(context: AccountDeletionContext, identityDeleted: boolean): Promise<DeletionJob> {
    return this.acceptPrepared(context.clerkUserId, identityDeleted, async () => context);
  }
  async acceptPrepared(
    owner: string,
    identityDeleted: boolean,
    prepare: (transaction: Transaction<PlatformDatabase>) => Promise<AccountDeletionContext>,
  ): Promise<DeletionJob> {
    const ownerHash = this.ownerHash(owner);
    return this.db.transaction().execute(async (trx) => {
      // Native Apple capture and deletion acceptance share this owner lock.
      // Read credentials only after the capture's remote metadata write commits.
      await lockAccountDeletionOwner(trx, ownerHash);
      const existing = await trx.selectFrom('account_deletion_jobs').selectAll()
        .where('owner_hash', '=', ownerHash).forUpdate().executeTakeFirst();
      if (existing && existing.status !== 'cancelled') {
        if (!identityDeleted || existing.status === 'completed') return existing;
        const now = this.now().toISOString();
        return trx.updateTable('account_deletion_jobs').set({ due_at: now, next_attempt_at: now, updated_at: now })
          .where('owner_hash', '=', ownerHash).returningAll().executeTakeFirstOrThrow();
      }
      const context = await prepare(trx);
      if (context.clerkUserId !== owner) throw new Error('Account deletion preparation failed.');
      return this.acceptInTransaction(trx, context, identityDeleted, ownerHash);
    });
  }
  private async acceptInTransaction(
    trx: Transaction<PlatformDatabase>, context: AccountDeletionContext, identityDeleted: boolean, ownerHash: string,
  ): Promise<DeletionJob> {
    const now = this.now().toISOString();
    const due = new Date(this.now().getTime() + (identityDeleted ? 0 : ACCOUNT_DELETION_GRACE_MS)).toISOString();
    await trx.insertInto('account_deletion_jobs').values({
      owner_hash: ownerHash, status: 'scheduled', encrypted_context: this.encrypt(context, ownerHash),
      due_at: due, next_attempt_at: now, next_step: 0, billing_stopped: false, attempts: 0,
      lease_token: null, lease_expires_at: null, last_error_code: null, created_at: now, updated_at: now, completed_at: null,
    }).onConflict((oc) => oc.column('owner_hash').doNothing()).execute();
    const row = await trx.selectFrom('account_deletion_jobs').selectAll()
      .where('owner_hash', '=', ownerHash).forUpdate().executeTakeFirstOrThrow();
    if (row.status !== 'cancelled') return row;
    return trx.updateTable('account_deletion_jobs').set({
      status: 'scheduled', encrypted_context: this.encrypt(context, ownerHash), due_at: due,
      next_attempt_at: now, next_step: 0, billing_stopped: false, attempts: 0, last_error_code: null, created_at: now, updated_at: now,
    }).where('owner_hash', '=', ownerHash).returningAll().executeTakeFirstOrThrow();
  }
  async accelerate(owner: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await lockAccountDeletionOwner(trx, this.ownerHash(owner));
      const now = this.now().toISOString();
      await trx.updateTable('account_deletion_jobs').set({ due_at: now, next_attempt_at: now, updated_at: now })
        .where('owner_hash', '=', this.ownerHash(owner)).where('status', 'in', ['scheduled', 'processing']).execute();
    });
  }
  async cancel(owner: string): Promise<DeletionJob | undefined> {
    const now = this.now().toISOString();
    return this.db.transaction().execute(async (trx) => {
      await lockAccountDeletionOwner(trx, this.ownerHash(owner));
      const row = await trx.selectFrom('account_deletion_jobs').selectAll().where('owner_hash', '=', this.ownerHash(owner)).forUpdate().executeTakeFirst();
      if (!row || row.status === 'cancelled') return row;
      if (row.status !== 'scheduled' || row.due_at <= now || row.lease_token !== null || !row.billing_stopped) throw new AccountDeletionConflictError();
      return trx.updateTable('account_deletion_jobs').set({ status: 'cancelled', encrypted_context: null, updated_at: now, last_error_code: null })
        .where('owner_hash', '=', row.owner_hash).where('status', '=', 'scheduled').returningAll().executeTakeFirstOrThrow();
    });
  }
  async claim(owner: string | undefined, leaseMs: number): Promise<DeletionJob | undefined> {
    const now = this.now().toISOString();
    return this.db.transaction().execute(async (trx) => {
      let query = trx.selectFrom('account_deletion_jobs').selectAll().where('status', 'in', ['scheduled', 'processing'])
        .where('next_attempt_at', '<=', now)
        .where((eb) => eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', now)]))
        .where((eb) => eb.or([eb('next_step', '=', 0), eb('due_at', '<=', now)]));
      if (owner) query = query.where('owner_hash', '=', this.ownerHash(owner));
      const row = await query.orderBy('next_attempt_at').limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (!row) return undefined;
      return trx.updateTable('account_deletion_jobs').set({
        status: row.due_at <= now ? 'processing' : 'scheduled', lease_token: randomUUID(),
        lease_expires_at: new Date(this.now().getTime() + leaseMs).toISOString(),
        attempts: sql`attempts + 1`, updated_at: now,
      }).where('owner_hash', '=', row.owner_hash).returningAll().executeTakeFirstOrThrow();
    });
  }
  private fenced(job: DeletionJob) {
    return this.db.updateTable('account_deletion_jobs').where('owner_hash', '=', job.owner_hash)
      .where('lease_token', '=', job.lease_token).where('lease_expires_at', '>', this.now().toISOString());
  }
  async renew(job: DeletionJob, leaseMs: number): Promise<boolean> {
    const result = await this.fenced(job).set({ lease_expires_at: new Date(this.now().getTime() + leaseMs).toISOString() }).returning('owner_hash').executeTakeFirst();
    return result !== undefined;
  }
  async saveContext(job: DeletionJob, context: AccountDeletionContext): Promise<boolean> {
    if (this.ownerHash(context.clerkUserId) !== job.owner_hash) throw new Error('Account deletion preparation failed.');
    const result = await this.fenced(job).set({ encrypted_context: this.encrypt(context, job.owner_hash),
      updated_at: this.now().toISOString() }).returning('owner_hash').executeTakeFirst();
    return result !== undefined;
  }
  async checkpoint(job: DeletionJob, nextStep: number, leaseMs: number): Promise<boolean> {
    const result = await this.fenced(job).set({ next_step: nextStep, billing_stopped: nextStep > 0,
      lease_expires_at: new Date(this.now().getTime() + leaseMs).toISOString(), updated_at: this.now().toISOString(), last_error_code: null }).returning('owner_hash').executeTakeFirst();
    return result !== undefined;
  }
  async release(job: DeletionJob, completed: boolean): Promise<void> {
    await this.fenced(job).set({
      status: completed ? 'completed' : 'scheduled', lease_token: null, lease_expires_at: null,
      ...(completed ? { encrypted_context: null, completed_at: this.now().toISOString(), last_error_code: null, attempts: 0 } : {}),
      next_attempt_at: completed ? this.now().toISOString() : sql`due_at`, updated_at: this.now().toISOString(),
    }).execute();
  }
  async fail(job: DeletionJob): Promise<void> {
    const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(job.attempts - 1, 7));
    await this.fenced(job).set({ lease_token: null, lease_expires_at: null, last_error_code: 'cleanup_retry',
      next_attempt_at: new Date(this.now().getTime() + delayMs).toISOString(), updated_at: this.now().toISOString() }).execute();
  }
}
