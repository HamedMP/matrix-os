import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Kysely} from 'kysely';
import {createTestPGlite} from '../helpers/pglite-test-helper.js';
import {PostgresWorkspaceRepository,type WorkspaceDatabase} from '../../packages/workspace-worker/src/data/repository.js';
import {PostgresRuntimeStore} from '../../packages/workspace-worker/src/data/runtime-store.js';

describe('transactional runtime compute admission',()=>{
 let engine:Awaited<ReturnType<typeof createTestPGlite>>; let repo:PostgresWorkspaceRepository;
 const hooks={claim:vi.fn(async()=>true),allowed:vi.fn(async()=>true),completion:vi.fn(async()=>undefined),uncertain:vi.fn(async()=>undefined),confirmStopped:vi.fn(async()=>undefined)};
 beforeAll(async()=>{engine=await createTestPGlite();repo=new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({dialect:engine.dialect}));await repo.initialize();await new PostgresRuntimeStore(repo.db).initialize();});
 afterAll(async()=>{await repo.close();if(!engine.client.closed)await engine.client.close();});
 it('rejects an unadmitted Queue job without creating a runtime job',async()=>{
  hooks.claim.mockResolvedValueOnce(false); const store=new PostgresRuntimeStore(repo.db,hooks);
  expect(await store.claim({ownerId:'denied',jobId:'a',type:'wake'},100,1000,5000)).toBeNull();
  expect(await store.active('denied',100)).toEqual([]);
 });
 it('rolls completed state back if accounting fails',async()=>{
  const store=new PostgresRuntimeStore(repo.db,hooks);const lease=(await store.claim({ownerId:'settle',jobId:'a',type:'wake'},100,1000,5000))!;
  hooks.completion.mockRejectedValueOnce(new Error('settlement failure'));
  await expect(store.finish(lease,'completed',200)).rejects.toThrow('settlement failure');
  expect(await store.active('settle',200)).toHaveLength(1);
  expect(await store.finish(lease,'completed',200)).toBe(true);
 });
 it('blocks heartbeat after server revocation and retains hold until confirmed destruction',async()=>{
  const store=new PostgresRuntimeStore(repo.db,hooks);const lease=(await store.claim({ownerId:'revoke',jobId:'a',type:'wake'},100,1000,5000))!;
  hooks.allowed.mockResolvedValueOnce(false);expect(await store.heartbeat(lease,200,1000)).toBe(false);
  const generation=(await store.beginInterrupt(lease,200))!;expect(hooks.uncertain).toHaveBeenCalled();
  expect(await store.confirmStopped('revoke',generation-1,300)).toBe(false);
  expect(hooks.confirmStopped).not.toHaveBeenCalled();
  expect(await store.confirmStopped('revoke',generation,300)).toBe(true);
  expect(hooks.confirmStopped).toHaveBeenCalled();
 });
});
