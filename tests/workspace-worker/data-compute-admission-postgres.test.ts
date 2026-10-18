/** Opt-in real Postgres proof; unique owners only, no shared database teardown. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { admitWorkspaceChatMessage, PostgresWorkspaceRepository, type WorkspaceDatabase, type SharedChat } from '../../packages/workspace-worker/src/data/repository.js';
import { PostgresComputeBudgetStore } from '../../packages/workspace-worker/src/data/compute-budget.js';
import { PostgresComputeAdmissionStore, type AdmissionData, type AdmissionTransaction } from '../../packages/workspace-worker/src/data/compute-admission.js';
import { PostgresRuntimeStore } from '../../packages/workspace-worker/src/data/runtime-store.js';
import type { RuntimeJob, RuntimeLease } from '../../packages/workspace-worker/src/runtime/contracts.js';

const file = process.env.MATRIX_SHARED_WORKSPACE_TEST_DATABASE_FILE;
const url = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(file === undefined && url === undefined)('Postgres compute admission and outbox', () => {
  const prefix = `admit_${crypto.randomUUID().replaceAll('-', '')}`;
  const owners: string[] = [];
  const owner = () => { const id = `${prefix}_${owners.length}`; owners.push(id); return id; };
  let dbs: Kysely<AdmissionData>[] = [];
  let stores: PostgresComputeAdmissionStore[] = [];
  let budgets: PostgresComputeBudgetStore[] = [];
  let failChat = false;
  const chat = { type: 'chat' as const, chatId: 'chat_first', message: 'hello', idempotencyKey: 'request_1' };
  const input = async (trx: AdmissionTransaction, ownerId: string, value: { chatId: string; idempotencyKey: string; message: string }): Promise<SharedChat> => {
    const createdAt = new Date(0).toISOString();
    const id = `chat_${value.idempotencyKey}`;
    await trx.insertInto('shared_chats').values({ owner_id: ownerId, id, request_id: value.idempotencyKey, title: value.message, created_at: createdAt }).execute();
    await trx.insertInto('shared_chat_messages').values({ owner_id: ownerId, chat_id: id, request_id: value.idempotencyKey, id: `msg_${value.idempotencyKey}`, seq: 1, role: 'user', text: value.message, created_at: createdAt }).execute();
    if (failChat) throw new Error('input rejected');
    return { ownerId, id, title: value.message, createdAt };
  };
  const setup = async (id: string, allowanceMs = 1000, periodId = 'october', startsAt = 0, endsAt = 10000) => {
    await budgets[0].provisionPolicy({ ownerId: id, periodId, startsAt, endsAt, allowanceMs });
    await stores[0].configureAccount({ ownerId: id, periodId, state: 'active' }, 0);
  };
  const snapshot = (id: string, periodId = 'october') => budgets[0].snapshot({ ownerId: id, periodId });
  const transaction = <T>(fn: (trx: AdmissionTransaction) => Promise<T>) => dbs[0].transaction().execute(fn);
  const claim = (job: RuntimeJob, now = 200, generation = 1) => transaction((trx) => stores[0].claim(trx, job, now, 200, generation));
  const lease = (job: RuntimeJob, generation = 1): RuntimeLease => ({ ownerId: job.ownerId, jobId: job.jobId, generation, expiresAt: 400, maxRunAt: 400 });
  beforeAll(async () => {
    const connectionString = file !== undefined ? readFileSync(file, 'utf8').trim() : url!.trim();
    if (!connectionString) throw new Error('Disposable Postgres connection required');
    dbs = [0, 1].map(() => new Kysely<AdmissionData>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 }) }) }));
    budgets = dbs.map((db) => new PostgresComputeBudgetStore(db));
    stores = dbs.map((db) => new PostgresComputeAdmissionStore(db, input));
    await new PostgresWorkspaceRepository(dbs[0], false).initialize();
    await new PostgresRuntimeStore(dbs[0] as unknown as Kysely<WorkspaceDatabase>).initialize();
    await budgets[0].initialize();
    await stores[0].initialize();
    await stores[0].initialize();
  });
  afterAll(async () => {
    try { if (dbs[0]) await dbs[0].transaction().execute(async (trx) => {
      for (const table of ['shared_runtime_jobs', 'shared_compute_outbox', 'shared_compute_accounts', 'shared_compute_reservations', 'shared_compute_policies', 'shared_chat_messages', 'shared_chats', 'shared_workspaces'] as const) await trx.deleteFrom(table).where('owner_id', 'in', owners).execute();
    }); } finally { await Promise.all(dbs.map((db) => db.destroy())); }
  });
  it('fails closed without authority, rejects personal placement and invalid boundaries', async () => {
    const missing = owner();
    await expect(stores[0].admit(missing, chat, 200, 100)).rejects.toMatchObject({ code: 'policy_unavailable' });
    const personal = owner(); await setup(personal);
    await dbs[0].updateTable('shared_workspaces').set({ placement: 'personal' }).where('owner_id', '=', personal).execute();
    await expect(stores[0].admit(personal, chat, 200, 100)).rejects.toMatchObject({ code: 'policy_unavailable' });
    await expect(stores[0].admit('invalid/owner', chat, 200, 100)).rejects.toMatchObject({ code: 'invalid' });
    await expect(stores[0].admit(personal, { ...chat, message: ' ' }, 200, 100)).rejects.toMatchObject({ code: 'invalid' });
    expect(await snapshot(personal)).toMatchObject({ heldMs: 0 });
  });
  it('atomically saves canonical input, reserves and stores outbox; duplicates survive rollover', async () => {
    const id = owner(); await setup(id, 200);
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => stores[index % 2].admit(id, chat, 200, 100)));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(results[0]).toMatchObject({ chatId: 'chat_request_1', job: { ownerId: id, jobId: 'request_1', chatId: 'chat_request_1' } });
    expect(await snapshot(id)).toMatchObject({ heldMs: 200 });
    expect(await dbs[0].selectFrom('shared_chat_messages').selectAll().where('owner_id', '=', id).execute()).toHaveLength(1);
    await setup(id, 500, 'november', 10000, 20000);
    await expect(stores[1].admit(id, chat, 200, 10100)).rejects.toMatchObject({code:'conflict'});
    await expect(stores[0].admit(id, { ...chat, message: 'changed' }, 200, 10100)).rejects.toMatchObject({ code: 'conflict' });
    await expect(stores[0].admit(id, chat, 201, 10100)).rejects.toMatchObject({ code: 'conflict' });
    expect(await snapshot(id, 'november')).toMatchObject({ heldMs: 0 });
  });
  it('rolls back input and holds together; competing requests cannot overspend', async () => {
    const id = owner(); await setup(id, 200);
    failChat = true;
    await expect(stores[0].admit(id, chat, 200, 100)).rejects.toThrow('input rejected');
    failChat = false;
    expect(await snapshot(id)).toMatchObject({ heldMs: 0 });
    expect(await dbs[0].selectFrom('shared_chats').selectAll().where('owner_id', '=', id).execute()).toHaveLength(0);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => stores[index % 2].admit(id, { ...chat, idempotencyKey: `key_${index}` }, 200, 100)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4);
    expect(await snapshot(id)).toMatchObject({ heldMs: 200 });
  });
  it('retries ambiguous Queue sends without refunding and refuses spoofed delivery', async () => {
    const id = owner(); await setup(id);
    const admitted = await stores[0].admit(id, chat, 200, 100);
    const failed = vi.fn(async () => { throw new Error('ack lost'); });
    await stores[0].dispatch(failed, 100, 100);
    expect(failed).toHaveBeenCalledWith(admitted.job);
    expect(await snapshot(id)).toMatchObject({ heldMs: 200 });
    const delivered: RuntimeJob[] = [];
    await stores[0].dispatch(async (job) => { delivered.push(job); }, 31100, 100);
    expect(delivered).toContainEqual(admitted.job);
    expect(await stores[0].validate({ ...admitted.job, message: 'spoof' })).toBeNull();
    expect(await stores[0].validate(admitted.job)).toEqual(admitted.job);
    expect(await claim({ ...admitted.job, message: 'spoof' })).toBe(false);
    expect(await claim(admitted.job)).toBe(true);
    expect(await claim(admitted.job)).toBe(false);
  });
  it('settles elapsed time once inside completion transaction and rejects stale generations', async () => {
    const id = owner(); await setup(id);
    const { job } = await stores[0].admit(id, chat, 200, 100);
    expect(await claim(job)).toBe(true);
    await expect(transaction((trx) => stores[0].completion(trx, lease(job, 2), 260))).rejects.toMatchObject({ code: 'conflict' });
    expect(await snapshot(id)).toMatchObject({ heldMs: 200, settledMs: 0 });
    await transaction((trx) => stores[0].completion(trx, lease(job), 260));
    await transaction((trx) => stores[0].completion(trx, lease(job), 390));
    expect(await snapshot(id)).toMatchObject({ heldMs: 0, settledMs: 60 });
    expect(await stores[0].admit(id,chat,200,400)).toMatchObject({state:'completed',jobId:job.jobId});
    expect(await stores[0].validate(job)).toBeNull();
  });
  it('keeps uncertain holds until confirmed old-generation destruction; newer work is protected', async () => {
    const id = owner(); await setup(id);
    const { job } = await stores[0].admit(id, chat, 200, 100); await claim(job);
    await transaction((trx) => stores[0].uncertain(trx, id, 1));
    expect(await snapshot(id)).toMatchObject({ heldMs: 200 });
    await transaction((trx) => stores[0].confirmStopped(trx, id, 1, 500));
    expect(await snapshot(id)).toMatchObject({ heldMs: 200 });
    const next = await stores[0].admit(id, { ...chat, idempotencyKey: 'next' }, 200, 100);
    await claim(next.job, 200, 2);
    await transaction((trx) => stores[0].confirmStopped(trx, id, 2, 500));
    expect(await snapshot(id)).toMatchObject({ heldMs: 200, settledMs: 200 });
  });
  it('serializes competing claims and rolls runtime claim/completion back with its caller transaction', async () => {
    const id = owner(); await setup(id);
    const { job } = await stores[0].admit(id, chat, 200, 100);
    await expect(transaction(async (trx) => {
      expect(await stores[0].claim(trx, job, 200, 200, 1)).toBe(true);
      throw new Error('runtime insert rejected');
    })).rejects.toThrow('runtime insert rejected');
    expect(await stores[0].validate(job)).toEqual(job);
    const attempts = await Promise.all(dbs.map((db, index) => db.transaction().execute((trx) => stores[index].claim(trx, job, 200, 200, 1))));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    await expect(transaction(async (trx) => {
      await stores[0].completion(trx, lease(job), 250);
      throw new Error('runtime finish rejected');
    })).rejects.toThrow('runtime finish rejected');
    expect(await snapshot(id)).toMatchObject({ heldMs: 200, settledMs: 0 });
    await transaction((trx) => stores[0].completion(trx, lease(job), 250));
    expect(await snapshot(id)).toMatchObject({ heldMs: 0, settledMs: 50 });
  });
  it('caps pending owner work and rejects a runtime policy larger than its hold', async () => {
    const id = owner(); await setup(id, 100000);
    const first = await stores[0].admit(id, chat, 200, 100);
    expect(await transaction((trx) => stores[0].claim(trx, first.job, 200, 201, 1))).toBe(false);
    for (let index = 0; index < 99; index++) await stores[0].admit(id, { type: 'wake' }, 200, 100);
    await expect(stores[1].admit(id, { type: 'wake' }, 200, 100)).rejects.toMatchObject({ code: 'exhausted' });
    expect(await snapshot(id)).toMatchObject({ heldMs: 20000 });
    await stores[0].configureAccount({ ownerId: id, periodId: 'october', state: 'suspended' }, 250);
    expect(await snapshot(id)).toMatchObject({ heldMs: 0, settledMs: 0 });
  });
  it('rejects delivery after period closure or personal handoff without starting compute', async () => {
    const id = owner(); await setup(id);
    const first = await stores[0].admit(id, chat, 200, 100);
    expect(await claim(first.job, 10000)).toBe(false);
    expect(await snapshot(id)).toMatchObject({ heldMs: 0, settledMs: 0 });
    const second = await stores[0].admit(id, { ...chat, idempotencyKey: 'handoff' }, 200, 100);
    await dbs[0].updateTable('shared_workspaces').set({ placement: 'personal' }).where('owner_id', '=', id).execute();
    expect(await claim(second.job)).toBe(false);
    expect(await snapshot(id)).toMatchObject({ heldMs: 0, settledMs: 0 });
  });
  it('revocation refunds pending only; running work remains held until termination and cannot revive deletion', async () => {
    const id = owner(); await setup(id);
    const running = await stores[0].admit(id, chat, 200, 100); await claim(running.job);
    const pending = await stores[0].admit(id, { ...chat, idempotencyKey: 'pending' }, 200, 100);
    expect(await stores[0].configureAccount({ ownerId: id, periodId: 'october', state: 'deleted' }, 250)).toEqual({ needsStop: true });
    expect(await snapshot(id)).toMatchObject({ heldMs: 200, settledMs: 0 });
    await expect(transaction((trx) => stores[0].completion(trx, lease(running.job), 260))).rejects.toMatchObject({ code: 'conflict' });
    expect(await transaction((trx) => stores[0].needsInterruption(trx, id, 1))).toBe(true);
    expect(await claim(pending.job)).toBe(false);
    expect(await transaction((trx) => stores[0].allowed(trx, id))).toBe(false);
    await expect(stores[0].admit(id, { type: 'wake' }, 200, 250)).rejects.toMatchObject({ code: 'policy_unavailable' });
    expect(await stores[0].reconcileOwners(300, 100)).toContain(id);
    await transaction((trx) => stores[0].confirmStopped(trx, id, 2, 400));
    expect(await snapshot(id)).toMatchObject({ heldMs: 0, settledMs: 200 });
    await expect(stores[0].configureAccount({ ownerId: id, periodId: 'october', state: 'active' }, 500)).rejects.toMatchObject({ code: 'policy_unavailable' });
  });
  it('rejects a prematurely settled hold and scopes dispatch to its authenticated owner', async () => {
    const firstOwner = owner(); const secondOwner = owner(); await setup(firstOwner); await setup(secondOwner);
    const first = await stores[0].admit(firstOwner, chat, 200, 100);
    const second = await stores[0].admit(secondOwner, chat, 200, 100);
    const sent: RuntimeJob[] = [];
    await stores[0].dispatch(async (job) => { sent.push(job); }, 100, 100, firstOwner);
    expect(sent).toEqual([first.job]);
    await budgets[0].settle({ ownerId: secondOwner, reservationId: second.jobId, actualMs: 0 });
    expect(await claim(second.job)).toBe(false);
  });
  it('expires never-claimed queued work and never refunds a previously claimed job', async () => {
    const id = owner(); await setup(id, 1000, 'october', 0, 2000000);
    const pending = await stores[0].admit(id, chat, 200, 100);
    const running = await stores[0].admit(id, { ...chat, idempotencyKey: 'running' }, 200, 100); await claim(running.job);
    await stores[0].dispatch(async () => undefined, 1000100, 100);
    expect(await claim(pending.job, 1000100)).toBe(false);
    expect(await snapshot(id)).toMatchObject({ heldMs: 200 });
  });
  it('wires canonical Chat, runtime claim, revocation and settlement in actual shared transactions',async()=>{
    const id=owner();await setup(id);
    const compute=new PostgresComputeAdmissionStore(dbs[0],(trx,owner,input)=>admitWorkspaceChatMessage(trx as unknown as Kysely<WorkspaceDatabase>,owner,input));
    const runtime=new PostgresRuntimeStore(dbs[0] as unknown as Kysely<WorkspaceDatabase>,compute.runtimeHooks());
    const first=await compute.admit(id,chat,200,100);
    const active=(await runtime.claim(first.job,200,100,200))!;
    expect(await runtime.finish(active,'completed',250)).toBe(true);
    expect(await snapshot(id)).toMatchObject({heldMs:0,settledMs:50});
    const next=await compute.admit(id,{...chat,chatId:first.chatId!,idempotencyKey:'revoked'},200,260);
    const revoked=(await runtime.claim(next.job,270,100,200))!;
    await compute.configureAccount({ownerId:id,periodId:'october',state:'suspended'},280);
    expect(await runtime.status(id)).toMatchObject({state:'interrupting',generation:2});
    await compute.configureAccount({ownerId:id,periodId:'october',state:'active'},281);
    expect(await runtime.heartbeat(revoked,290,100)).toBe(false);
    expect(await runtime.finish(revoked,'completed',295)).toBe(false);
    expect(await runtime.active(id,295)).toHaveLength(0);
    expect(await runtime.beginInterrupt(revoked,300)).toBeNull();
    const repository=new PostgresWorkspaceRepository(dbs[0] as unknown as Kysely<WorkspaceDatabase>,false);
    await expect(repository.publishOutput(revoked,{text:'late output',files:[]},295)).rejects.toMatchObject({code:'conflict'});
    expect(await snapshot(id)).toMatchObject({heldMs:200,settledMs:50});
    expect(await runtime.confirmStopped(id,2,310)).toBe(true);
    expect(await snapshot(id)).toMatchObject({heldMs:0,settledMs:250});
    expect((await runtime.status(id)).state).toBe('failed');
  });
  it('quarantines crash-expired work before releasing any uncertain hold',async()=>{
    const id=owner();await setup(id);
    const compute=new PostgresComputeAdmissionStore(dbs[0],input);
    const runtime=new PostgresRuntimeStore(dbs[0] as unknown as Kysely<WorkspaceDatabase>,compute.runtimeHooks());
    const admitted=await compute.admit(id,chat,200,100);
    await runtime.claim(admitted.job,200,100,200);
    await runtime.recoverExpired(id,301);
    expect(await runtime.status(id)).toMatchObject({state:'interrupting',generation:2});
    expect(await snapshot(id)).toMatchObject({heldMs:200,settledMs:0});
    expect(await runtime.confirmStopped(id,1,310)).toBe(false);
    expect(await snapshot(id)).toMatchObject({heldMs:200});
    expect(await runtime.confirmStopped(id,2,320)).toBe(true);
    expect(await snapshot(id)).toMatchObject({heldMs:0,settledMs:200});
  });

  it('reconciles a completed warm runtime after a lost idle alarm, then stops scanning confirmed termination',async()=>{
    const id=owner();await setup(id);
    const compute=new PostgresComputeAdmissionStore(dbs[0],input);
    const runtime=new PostgresRuntimeStore(dbs[0] as unknown as Kysely<WorkspaceDatabase>,compute.runtimeHooks());
    const admitted=await compute.admit(id,chat,200,100);
    const active=(await runtime.claim(admitted.job,200,100,200))!;
    await runtime.finish(active,'completed',250);
    expect(await compute.reconcileOwners(300,100)).toContain(id);
    await runtime.beginCheckpoint(id,400,100);await runtime.fail(id,1);
    expect(await compute.reconcileOwners(450,100)).toContain(id);
    const generation=(await runtime.beginIdleInterrupt(id,1,500))!;
    await runtime.confirmStopped(id,generation,510);
    expect(await compute.reconcileOwners(550,100)).not.toContain(id);
  });

});
