import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely } from 'kysely';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { PostgresWorkspaceRepository, type WorkspaceDatabase } from '../../packages/workspace-worker/src/data/repository.js';
import { createWorkspaceRoutes } from '../../packages/workspace-worker/src/routes.js';
import { hydrateWorkspace, publishRuntimeOutput } from '../../packages/workspace-worker/src/bridge.js';

describe('private runtime paths at shared data boundaries', () => {
  let engine: Awaited<ReturnType<typeof createTestPGlite>>;
  let repository: PostgresWorkspaceRepository;
  const token = 'isolated_preview_token_at_least_32_bytes';
  const files = { write:vi.fn(async ()=>'object'), read:vi.fn(async ()=>'text'), remove:vi.fn() };
  beforeAll(async () => {
    engine = await createTestPGlite();
    repository = new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({dialect:engine.dialect}));
    await repository.initialize();
  });
  afterAll(async () => { await repository?.close(); if(engine && !engine.client.closed) await engine.client.close(); });
  it.each(['.matrix-runtime','.matrix-runtime/sessions.json','.matrix-runtime/nested/notes.txt'])(
    'rejects %s before storing bytes or metadata', async path => {
      files.write.mockClear();
      const app = createWorkspaceRoutes({repository,files,runtime:{status:vi.fn(),enqueue:vi.fn()},
        auth:{previewBearer:{token,ownerId:'private_path_owner'}},previewEnabled:true});
      const result = await app.fetch(new Request('https://shared.test/api/files/text',{
        method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:JSON.stringify({path,content:'not runtime state',baseRevision:0}),
      }));
      expect(result.status).toBe(400);
      expect(files.write).not.toHaveBeenCalled();
      await expect(repository.commitFile('private_path_owner',path,'object',1,0)).rejects.toMatchObject({code:'invalid'});
    });
  it('excludes legacy private rows before the list limit and hydration cap', async () => {
    const ownerId='legacy_private_paths';
    await repository.db.insertInto('shared_files').values(Array.from({length:100},(_,index)=>({
      owner_id:ownerId,path:`.matrix-runtime/legacy_${index}`,object_key:`private-${index}`,bytes:1,revision:1,updated_at:new Date(0).toISOString(),
    }))).execute();
    await repository.commitFile(ownerId,'notes/saved.txt','public-object',4,0);
    expect((await repository.listFiles(ownerId,'',1)).map(file=>file.path)).toEqual(['notes/saved.txt']);
    expect(await repository.file(ownerId,'.matrix-runtime/legacy_0')).toBeNull();
    const reader={read:vi.fn(async ()=>'saved')};
    expect(await hydrateWorkspace(repository,reader as never,ownerId)).toEqual([{path:'notes/saved.txt',content:'saved'}]);
    expect(reader.read).toHaveBeenCalledExactlyOnceWith('public-object');
  });
  it('defensively skips reserved rows returned by another repository implementation',async()=>{
    const publicFile={path:'.matrix-runtime-notes.txt',objectKey:'public',revision:1};
    const repo={listFiles:vi.fn(async()=>[{path:'.matrix-runtime/sessions.json',objectKey:'private',revision:1},publicFile]),file:vi.fn(async()=>publicFile)};
    const reader={read:vi.fn(async ()=>'saved')};
    expect(await hydrateWorkspace(repo as never,reader as never,'owner')).toEqual([{path:publicFile.path,content:'saved'}]);
    expect(reader.read).toHaveBeenCalledExactlyOnceWith('public');
  });
  it('rejects private agent output before staging an object',async()=>{
    const outputFiles={write:vi.fn(),remove:vi.fn()};
    await expect(publishRuntimeOutput({file:vi.fn()} as never,outputFiles as never,{ownerId:'owner'} as never,
      {text:'done',files:[{path:'.matrix-runtime/sessions.json',content:'tampered'}]})).rejects.toThrow();
    expect(outputFiles.write).not.toHaveBeenCalled();
  });
});
