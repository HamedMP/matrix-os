import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely } from 'kysely';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { PostgresWorkspaceRepository, type WorkspaceDatabase } from '../../packages/workspace-worker/src/data/repository.js';
import { R2WorkspaceFiles } from '../../packages/workspace-worker/src/data/files.js';
import { runWorkspaceFileCleanup } from '../../packages/workspace-worker/src/data/cleanup.js';

describe('scheduled shared text orphan cleanup', () => {
  let engine: Awaited<ReturnType<typeof createTestPGlite>>;
  let repository: PostgresWorkspaceRepository;
  beforeAll(async () => {
    engine = await createTestPGlite();
    repository = new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({dialect:engine.dialect}));
    await repository.initialize();
  });
  afterAll(async () => { await repository?.close(); if(engine && !engine.client.closed) await engine.client.close(); });
  const reset = () => repository.db.deleteFrom('shared_cleanup_cursors').execute();
  it('persists one bounded R2 page cursor and retains current/recent objects', async () => {
    await reset();
    await repository.commitFile('cleanup_owner','live.txt','workspace-files/cleanup/live',4,0);
    const remove = vi.fn(async () => {});
    const list = vi.fn(async (options: {cursor?:string}) => options.cursor === 'page2'
      ? {objects:[],truncated:false}
      : {objects:[
        {key:'workspace-files/cleanup/live',uploaded:new Date(0)},
        {key:'workspace-files/cleanup/orphan',uploaded:new Date(0)},
        {key:'workspace-files/cleanup/recent',uploaded:new Date(100_000_000)},
      ],truncated:true,cursor:'page2'});
    const files = new R2WorkspaceFiles({get:async()=>null,put:async()=>null,delete:remove,list});
    expect(await runWorkspaceFileCleanup(repository,files,{now:()=>100_000_000})).toMatchObject({status:'completed',deleted:1});
    expect(remove).toHaveBeenCalledExactlyOnceWith('workspace-files/cleanup/orphan');
    expect((await repository.db.selectFrom('shared_cleanup_cursors').select('cursor').executeTakeFirstOrThrow()).cursor).toBe('page2');
    expect(await runWorkspaceFileCleanup(repository,files,{now:()=>100_000_001})).toMatchObject({status:'completed',deleted:0});
    expect(list.mock.calls[1][0]).toMatchObject({cursor:'page2',limit:100});
    expect((await repository.db.selectFrom('shared_cleanup_cursors').select('cursor').executeTakeFirstOrThrow()).cursor).toBeNull();
  });
  it('admits one scheduler at a time and resumes the same cursor after failure', async () => {
    await reset();
    let entered!: () => void;
    const started = new Promise<void>(resolve=>{entered=resolve;});
    let complete!: () => void;
    const waiting = new Promise<void>(resolve=>{complete=resolve;});
    const sweep = vi.fn(async () => {entered();await waiting;return {deleted:0,cursor:'continued'};});
    const first = runWorkspaceFileCleanup(repository,{sweepUnreferenced:sweep},{now:()=>1000});
    await started;
    expect(await runWorkspaceFileCleanup(repository,{sweepUnreferenced:sweep},{now:()=>1000})).toEqual({status:'busy',deleted:0});
    expect(sweep).toHaveBeenCalledTimes(1);
    complete(); await first;
    const fail = {sweepUnreferenced:vi.fn(async()=>{throw new Error('R2 unavailable');})};
    await expect(runWorkspaceFileCleanup(repository,fail,{now:()=>2000})).rejects.toThrow('R2 unavailable');
    const row = await repository.db.selectFrom('shared_cleanup_cursors').selectAll().executeTakeFirstOrThrow();
    expect(row.cursor).toBe('continued');
    const recover = {sweepUnreferenced:vi.fn(async()=>({deleted:0}))};
    // Failed pages keep their lease quarantined until the bounded expiry.
    expect(await runWorkspaceFileCleanup(repository,recover,{now:()=>3000})).toMatchObject({status:'busy'});
    expect(await runWorkspaceFileCleanup(repository,recover,{now:()=>63_000})).toMatchObject({status:'completed'});
    expect(recover.sweepUnreferenced.mock.calls[0][1]).toMatchObject({cursor:'continued'});
  });
  it('rejects a stale scheduler cursor completion after an expired lease was reclaimed', async () => {
    await reset();
    let entered!: () => void;
    const started = new Promise<void>(resolve=>{entered=resolve;});
    let release!: () => void;
    const waiting = new Promise<void>(resolve=>{release=resolve;});
    let now = 0;
    const slow = {sweepUnreferenced:async()=>{entered();await waiting;return {deleted:1,cursor:'stale-cursor'};}};
    const first = runWorkspaceFileCleanup(repository,slow,{now:()=>now});
    await started; now = 61_000;
    const replacement = {sweepUnreferenced:async()=>({deleted:0,cursor:'new-cursor'})};
    expect(await runWorkspaceFileCleanup(repository,replacement,{now:()=>now})).toMatchObject({status:'completed'});
    release();
    expect(await first).toMatchObject({status:'stale'});
    expect((await repository.db.selectFrom('shared_cleanup_cursors').select('cursor').executeTakeFirstOrThrow()).cursor).toBe('new-cursor');
  });
});
