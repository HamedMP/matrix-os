import { type Kysely, type Transaction } from 'kysely';
import { z } from 'zod/v4';
import { parseQueuedJob } from '../bridge.js';
import type { WorkspaceAction } from '../routes.js';
import type { RuntimeJob, RuntimeLease } from '../runtime/contracts.js';
import { ComputeBudgetError, reserveComputeBudget, settleComputeBudget, type ComputeBudgetDatabase } from './compute-budget.js';
import { ensureWorkspace, type ChatAdmissionInput, type SharedChat, type WorkspaceDatabase } from './repository.js';
import { initializeComputeAdmission, type AdmissionData, type AdmissionDatabase } from './compute-admission-schema.js';
export type { AdmissionData, AdmissionDatabase } from './compute-admission-schema.js';
export type AdmissionTransaction = Transaction<AdmissionData>;

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const time = z.number().int().min(0).max(8_639_999_999_100_000);
const amount = z.number().int().min(1).max(1_800_000);
const limitSchema = z.number().int().min(1).max(100);
const generationSchema = z.number().int().min(1).max(2_147_483_647);
const accountSchema = z.object({ ownerId: identity, periodId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), state: z.enum(['active', 'suspended', 'deleted']) }).strict();
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wake') }).strict(),
  z.object({ type: z.literal('chat'), chatId: z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/), message: z.string().trim().min(1).max(16000), idempotencyKey: identity }).strict(),
]);
function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ComputeBudgetError('invalid');
  return result.data;
}
type Outbox = AdmissionDatabase['shared_compute_outbox'];
export interface ComputeAdmission { job: RuntimeJob; jobId: string; state: 'queued'|'running'|'completed'; chatId?: string }
const result = (row: Outbox): ComputeAdmission => {
  if(row.state === 'cancelled' || row.state === 'uncertain' || row.state === 'interrupted') throw new ComputeBudgetError('conflict');
  const job = parseQueuedJob(row.payload);
  return { job, jobId: job.jobId, state: row.state === 'pending' ? 'queued' : row.state, ...(job.type === 'chat' ? { chatId: job.chatId } : {}) };
};
const sameJob = (row: Outbox, job: RuntimeJob): boolean => {
  const stored = parseQueuedJob(row.payload);
  return stored.ownerId === job.ownerId && stored.jobId === job.jobId && stored.type === job.type && stored.chatId === job.chatId && stored.message === job.message;
};
const budgetTransaction = (trx: AdmissionTransaction) => trx as unknown as Transaction<ComputeBudgetDatabase>;

/** Server-side authority and transactional outbox. An injected pool belongs to its caller.
 * Lock order: workspace owner, account/outbox, then budget policy. Queue acknowledgement
 * never settles a hold. Only never-claimed cancellation or final runtime proof may settle.
 */
export class PostgresComputeAdmissionStore {
  constructor(readonly db: Kysely<AdmissionData>, private readonly admitChat: (trx: AdmissionTransaction, ownerId: string, input: ChatAdmissionInput) => Promise<SharedChat>) {}
  initialize(): Promise<void> { return initializeComputeAdmission(this.db); }
  private async lock(trx: AdmissionTransaction, ownerId: string, create = false) {
    parse(identity, ownerId);
    if (create) await ensureWorkspace(trx as unknown as Kysely<WorkspaceDatabase>, ownerId);
    return trx.selectFrom('shared_workspaces').selectAll().where('owner_id', '=', ownerId).forUpdate().executeTakeFirst();
  }
  private row(trx: AdmissionTransaction, ownerId: string, jobId: string) {
    return trx.selectFrom('shared_compute_outbox').selectAll().where('owner_id', '=', ownerId).where('job_id', '=', jobId).executeTakeFirst();
  }
  private async cancelPending(trx: AdmissionTransaction, row: Outbox) {
    if (row.state !== 'pending' || row.started_at !== null) return;
    await settleComputeBudget(budgetTransaction(trx), { ownerId: row.owner_id, reservationId: row.job_id, actualMs: 0 });
    await trx.updateTable('shared_compute_outbox').set({ state: 'cancelled' }).where('owner_id', '=', row.owner_id).where('job_id', '=', row.job_id).where('state', '=', 'pending').execute();
  }
  /** No client tier/allowance input. Provision the policy separately through trusted control plane. */
  async configureAccount(raw: z.infer<typeof accountSchema>, now: number): Promise<{ needsStop: boolean }> {
    const input = parse(accountSchema, raw); parse(time, now);
    return this.db.transaction().execute(async (trx) => {
      const workspace=await this.lock(trx, input.ownerId, true);
      const previous = await trx.selectFrom('shared_compute_accounts').selectAll().where('owner_id', '=', input.ownerId).executeTakeFirst();
      if (previous?.state === 'deleted' && input.state !== 'deleted') throw new ComputeBudgetError('policy_unavailable');
      const policy = await trx.selectFrom('shared_compute_policies').select('owner_id').where('owner_id', '=', input.ownerId).where('period_id', '=', input.periodId).executeTakeFirst();
      if (!policy) throw new ComputeBudgetError('policy_unavailable');
      await trx.insertInto('shared_compute_accounts').values({ owner_id: input.ownerId, period_id: input.periodId, state: input.state })
        .onConflict((oc) => oc.column('owner_id').doUpdateSet({ period_id: input.periodId, state: input.state })).execute();
      const pending = await trx.selectFrom('shared_compute_outbox').selectAll().where('owner_id', '=', input.ownerId).where('state', '=', 'pending').execute();
      for (const row of pending) if (input.state !== 'active' || row.period_id !== input.periodId) await this.cancelPending(trx, row);
      if (input.state !== 'active') {
        const active = await trx.selectFrom('shared_compute_outbox').selectAll().where('owner_id', '=', input.ownerId).where('state', '=', 'running').execute();
        for (const row of active) await this.markUncertain(trx, row);
      }
      const running = await trx.selectFrom('shared_compute_outbox').select('job_id').where('owner_id', '=', input.ownerId).where('state', 'in', ['running', 'uncertain']).executeTakeFirst();
      const needsStop=input.state !== 'active' && !!running && workspace?.placement === 'pooled';
      if(needsStop && workspace.runtime_state !== 'interrupting') {
        // Revocation and output publication serialize on the same owner row.
        // Fence immediately, before returning; heartbeat is only recovery delivery.
        await trx.updateTable('shared_runtime_jobs').set({state:'interrupted'}).where('owner_id','=',input.ownerId).where('state','=','running').execute();
        await trx.updateTable('shared_workspaces').set({generation:workspace.generation+1,runtime_state:'interrupting',idle_since:now}).where('owner_id','=',input.ownerId).execute();
      }
      return { needsStop };
    });
  }
  async admit(ownerId: string, raw: WorkspaceAction, amountMs: number, now: number): Promise<ComputeAdmission> {
    parse(identity, ownerId); const action = parse(actionSchema, raw); parse(amount, amountMs); parse(time, now);
    const jobId = action.type === 'chat' ? action.idempotencyKey : crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const workspace = await this.lock(trx, ownerId, true);
      if (workspace?.placement !== 'pooled') throw new ComputeBudgetError('policy_unavailable');
      const account = await trx.selectFrom('shared_compute_accounts').selectAll().where('owner_id', '=', ownerId).executeTakeFirst();
      if (!account || account.state !== 'active') throw new ComputeBudgetError('policy_unavailable');
      const previous = await this.row(trx, ownerId, jobId);
      if (previous) {
        const old = actionSchema.safeParse(previous.fingerprint);
        if (!old.success || JSON.stringify(old.data) !== JSON.stringify(action) || previous.amount_ms !== amountMs) throw new ComputeBudgetError('conflict');
        return result(previous);
      }
      const count = await trx.selectFrom('shared_compute_outbox').select((eb) => eb.fn.countAll<number>().as('count')).where('owner_id', '=', ownerId).where('state', '=', 'pending').executeTakeFirstOrThrow();
      if (Number(count.count) >= 100) throw new ComputeBudgetError('exhausted');
      await reserveComputeBudget(budgetTransaction(trx), { ownerId, reservationId: jobId, periodId: account.period_id, amountMs, now });
      const canonical = action.type === 'chat' ? await this.admitChat(trx, ownerId, action) : null;
      const job = parseQueuedJob(action.type === 'chat' ? { ownerId, jobId, type: 'chat', chatId: canonical!.id, message: action.message } : { ownerId, jobId, type: 'wake' });
      const row = await trx.insertInto('shared_compute_outbox').values({
        owner_id: ownerId, job_id: jobId, period_id: account.period_id, amount_ms: amountMs, fingerprint: { ...action }, payload: { ...job },
        state: 'pending', queued_at: now, expires_at: now + 900_000, delivery_at: null, enqueued_at: null, started_at: null, generation: null, reconcile_at: 0,
      }).returningAll().executeTakeFirstOrThrow();
      return result(row);
    });
  }
  /** Queue payloads are references to a durable authority record, never admission themselves. */
  async validate(raw: RuntimeJob): Promise<RuntimeJob | null> {
    const job = parseQueuedJob(raw);
    const row = await this.db.selectFrom('shared_compute_outbox').selectAll().where('owner_id', '=', job.ownerId).where('job_id', '=', job.jobId).executeTakeFirst();
    return row && row.state === 'pending' && sameJob(row, job) ? parseQueuedJob(row.payload) : null;
  }
  /** A failed send can have delivered. Keep its hold and retry the exact durable payload. */
  async dispatch(send: (job: RuntimeJob) => Promise<void>, now: number, limit = 100, ownerId?: string): Promise<number> {
    parse(time, now); parse(limitSchema, limit); if (ownerId !== undefined) parse(identity, ownerId);
    let query = this.db.selectFrom('shared_compute_outbox').selectAll().where('state', '=', 'pending')
      .where((eb) => eb.or([eb('delivery_at', 'is', null), eb('delivery_at', '<=', now - 30_000), eb('expires_at', '<=', now)]))
      .orderBy('queued_at').orderBy('owner_id').limit(limit);
    if (ownerId !== undefined) query = query.where('owner_id', '=', ownerId);
    const rows = await query.execute();
    let delivered = 0;
    for (const candidate of rows) {
      const job = await this.db.transaction().execute(async (trx) => {
        await this.lock(trx, candidate.owner_id);
        const row = await this.row(trx, candidate.owner_id, candidate.job_id);
        if (!row || row.state !== 'pending') return null;
        if (now >= row.expires_at || !(await this.allowed(trx, row.owner_id))) { await this.cancelPending(trx, row); return null; }
        if (row.delivery_at !== null && row.delivery_at > now - 30_000) return null;
        await trx.updateTable('shared_compute_outbox').set({ delivery_at: now }).where('owner_id', '=', row.owner_id).where('job_id', '=', row.job_id).execute();
        return parseQueuedJob(row.payload);
      });
      if (!job) continue;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([send(job), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Queue acknowledgement unavailable')), 10_000); })]);
        await this.db.updateTable('shared_compute_outbox').set({ enqueued_at: now }).where('owner_id', '=', job.ownerId).where('job_id', '=', job.jobId).where('state', '=', 'pending').execute();
        delivered++;
      } catch (error) { console.error('[workspace-compute] delivery acknowledgement unavailable', error instanceof Error ? error.name : 'UnknownError'); }
      finally { clearTimeout(timeout); }
    }
    return delivered;
  }
  async allowed(trx: AdmissionTransaction, ownerId: string): Promise<boolean> {
    const workspace = await this.lock(trx, ownerId);
    if (workspace?.placement !== 'pooled') return false;
    const account = await trx.selectFrom('shared_compute_accounts').select('state').where('owner_id', '=', ownerId).executeTakeFirst();
    return account?.state === 'active';
  }
  /** Called inside runtime claim's owner lock; no start is allowed on an unauthorised Queue message. */
  async claim(trx: AdmissionTransaction, raw: RuntimeJob, now: number, maxRunMs: number, generation: number): Promise<boolean> {
    const job = parseQueuedJob(raw); parse(time, now); parse(amount, maxRunMs); parse(generationSchema, generation);
    await this.lock(trx, job.ownerId);
    const row = await this.row(trx, job.ownerId, job.jobId);
    if (!row || row.state !== 'pending' || !sameJob(row, job)) return false;
    const account = await trx.selectFrom('shared_compute_accounts').selectAll().where('owner_id', '=', job.ownerId).executeTakeFirst();
    const policy = await trx.selectFrom('shared_compute_policies').selectAll().where('owner_id', '=', job.ownerId).where('period_id', '=', row.period_id).forUpdate().executeTakeFirst();
    if (!(await this.allowed(trx, job.ownerId)) || account?.period_id !== row.period_id || !policy || now < policy.starts_at || now >= policy.ends_at || now >= row.expires_at) {
      await this.cancelPending(trx, row); return false;
    }
    const reservation = await trx.selectFrom('shared_compute_reservations').selectAll().where('owner_id', '=', job.ownerId).where('reservation_id', '=', job.jobId).executeTakeFirst();
    if (!reservation || reservation.state !== 'held' || reservation.amount_ms !== row.amount_ms || reservation.period_id !== row.period_id || now < row.queued_at || maxRunMs > row.amount_ms) return false;
    await trx.updateTable('shared_compute_outbox').set({ state: 'running', started_at: now, generation }).where('owner_id', '=', job.ownerId).where('job_id', '=', job.jobId).where('state', '=', 'pending').execute();
    return true;
  }
  async completion(trx: AdmissionTransaction, lease: RuntimeLease, now: number): Promise<void> {
    parse(time, now); parse(generationSchema, lease.generation); parse(identity, lease.jobId);
    await this.lock(trx, lease.ownerId);
    const row = await this.row(trx, lease.ownerId, lease.jobId);
    if (row?.state === 'completed' && row.generation === lease.generation) return;
    if (!row || row.state !== 'running' || row.generation !== lease.generation || row.started_at === null || now < row.started_at) throw new ComputeBudgetError('conflict');
    await settleComputeBudget(budgetTransaction(trx), { ownerId: row.owner_id, reservationId: row.job_id, actualMs: Math.min(row.amount_ms, now - row.started_at) });
    await trx.updateTable('shared_compute_outbox').set({ state: 'completed' }).where('owner_id', '=', row.owner_id).where('job_id', '=', row.job_id).execute();
  }
  private async markUncertain(trx: AdmissionTransaction, row: Outbox) {
    await trx.updateTable('shared_compute_outbox').set({ state: 'uncertain' }).where('owner_id', '=', row.owner_id).where('job_id', '=', row.job_id).where('state', '=', 'running').execute();
    await trx.updateTable('shared_compute_reservations').set({ state: 'uncertain' }).where('owner_id', '=', row.owner_id).where('reservation_id', '=', row.job_id).where('state', '=', 'held').execute();
  }
  async uncertain(trx: AdmissionTransaction, ownerId: string, generation: number): Promise<void> {
    parse(generationSchema, generation); await this.lock(trx, ownerId);
    const rows = await trx.selectFrom('shared_compute_outbox').selectAll().where('owner_id', '=', ownerId).where('generation', '=', generation).where('state', '=', 'running').execute();
    for (const row of rows) await this.markUncertain(trx, row);
  }
  async needsInterruption(trx: AdmissionTransaction, ownerId: string, generation: number): Promise<boolean> {
    parse(generationSchema, generation); await this.lock(trx, ownerId);
    return !!(await trx.selectFrom('shared_compute_outbox').select('job_id').where('owner_id', '=', ownerId)
      .where('state', '=', 'uncertain').where('generation', '<=', generation).executeTakeFirst());
  }
  /** Caller has confirmed destruction and fenced the owner to currentGeneration. */
  async confirmStopped(trx: AdmissionTransaction, ownerId: string, currentGeneration: number, now: number): Promise<void> {
    parse(time, now); parse(generationSchema, currentGeneration); await this.lock(trx, ownerId);
    const rows = await trx.selectFrom('shared_compute_outbox').selectAll().where('owner_id', '=', ownerId).where('state', '=', 'uncertain').where('generation', '<', currentGeneration).execute();
    for (const row of rows) {
      await settleComputeBudget(budgetTransaction(trx), { ownerId, reservationId: row.job_id, actualMs: row.amount_ms });
      // Confirmed termination settles accounting, never successful task completion.
      await trx.updateTable('shared_compute_outbox').set({ state: 'interrupted' }).where('owner_id', '=', ownerId).where('job_id', '=', row.job_id).execute();
    }
  }
  /** Rotate bounded reconciliation candidates so a failed owner cannot starve other owners. */
  async reconcileOwners(now: number, limit = 100): Promise<string[]> {
    parse(time, now); parse(limitSchema, limit);
    const candidates = await this.db.selectFrom('shared_compute_outbox as outbox')
      .innerJoin('shared_workspaces as workspace','workspace.owner_id','outbox.owner_id')
      .select('outbox.owner_id as owner_id').select((eb) => eb.fn.min<number>('outbox.reconcile_at').as('oldest'))
      .where('workspace.placement','=','pooled')
      .where(eb=>eb.or([
        eb('outbox.state','in',['running','uncertain']),
        eb('workspace.runtime_state','in',['running','ready','checkpointing','interrupting']),
        eb.and([eb('workspace.runtime_state','=','failed'),eb('workspace.idle_since','is not',null)]),
      ]))
      .groupBy('outbox.owner_id').orderBy('oldest').orderBy('outbox.owner_id').limit(limit).execute();
    for (const candidate of candidates) await this.db.transaction().execute(async (trx) => {
      await this.lock(trx, candidate.owner_id);
      await trx.updateTable('shared_compute_outbox').set({ reconcile_at: now }).where('owner_id', '=', candidate.owner_id).execute();
    });
    return candidates.map((row) => row.owner_id);
  }
  /** Structural adapter keeps the runtime's existing DB surface independent of this schema. */
  runtimeHooks() {
    const cast = (trx: Transaction<WorkspaceDatabase>) => trx as unknown as AdmissionTransaction;
    return {
      allowed: (trx: Transaction<WorkspaceDatabase>, owner: string) => this.allowed(cast(trx), owner),
      claim: (trx: Transaction<WorkspaceDatabase>, job: RuntimeJob, now: number, max: number, generation: number) => this.claim(cast(trx), job, now, max, generation),
      completion: (trx: Transaction<WorkspaceDatabase>, lease: RuntimeLease, now: number) => this.completion(cast(trx), lease, now),
      needsInterruption: (trx: Transaction<WorkspaceDatabase>, owner: string, generation: number) => this.needsInterruption(cast(trx), owner, generation),
      uncertain: (trx: Transaction<WorkspaceDatabase>, owner: string, generation: number) => this.uncertain(cast(trx), owner, generation),
      confirmStopped: (trx: Transaction<WorkspaceDatabase>, owner: string, generation: number, now: number) => this.confirmStopped(cast(trx), owner, generation, now),
    };
  }
}
