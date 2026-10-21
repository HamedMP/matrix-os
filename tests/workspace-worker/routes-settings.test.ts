import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely } from 'kysely';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { PostgresWorkspaceRepository, type WorkspaceDatabase } from '../../packages/workspace-worker/src/data/repository.js';
import { createWorkspaceRoutes } from '../../packages/workspace-worker/src/routes.js';

describe('shared Web Desktop Appearance settings contract', () => {
  let engine: Awaited<ReturnType<typeof createTestPGlite>>;
  let repository: PostgresWorkspaceRepository;
  const token = 'shared_preview_appearance_test_token';
  const runtime = {status:vi.fn(),enqueue:vi.fn()};
  const files = {read:vi.fn(),write:vi.fn(),remove:vi.fn()};
  beforeAll(async()=>{
    engine=await createTestPGlite();
    repository=new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({dialect:engine.dialect}));
    await repository.initialize();
  });
  afterAll(async()=>{await repository?.close();if(engine&&!engine.client.closed)await engine.client.close();});
  const request = (owner:string,body?:unknown,method='PATCH',authorized=true) => {
    const app=createWorkspaceRoutes({repository,files,runtime,auth:{previewBearer:{token,ownerId:owner}},previewEnabled:true});
    return app.fetch(new Request('https://shared.test/api/settings/desktop',{method,headers:{'content-type':'application/json',...(authorized?{authorization:`Bearer ${token}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
  };
  it('accepts the Shell PATCH shape and returns merged durable config without waking compute',async()=>{
    await repository.saveSetting('appearance_owner','desktop',{
      background:{type:'solid',color:'#123456'},dock:{position:'left',size:56,iconSize:40,autoHide:false},
      pinnedApps:['__chat__','__workspace__'],dockOrder:{userApps:['notes'],systemApps:['__chat__']},
    },0);
    const response=await request('appearance_owner',{dock:{position:'bottom'},iconStyle:'rounded'});
    expect(response.status).toBe(200);
    const payload=await response.json();
    expect(payload).toMatchObject({ok:true,config:{background:{type:'solid',color:'#123456'},dock:{position:'bottom',size:56,iconSize:40,autoHide:false},pinnedApps:['__chat__'],iconStyle:'rounded'}});
    const persisted=(await repository.settings('appearance_owner')).desktop;
    expect(persisted).toMatchObject({dock:{position:'bottom',size:56},pinnedApps:['__chat__','__workspace__'],dockOrder:{userApps:['notes']}});
    expect((await repository.settingsSnapshot('appearance_owner')).revision).toBe(2);
    expect(await (await request('another_appearance_owner',undefined,'GET')).json()).not.toMatchObject({iconStyle:'rounded'});
    expect(runtime.enqueue).not.toHaveBeenCalled();
  });
  it('serializes concurrent nested patches so both changes persist',async()=>{
    const responses=await Promise.all([
      request('appearance_concurrent',{dock:{position:'right'}}),
      request('appearance_concurrent',{dock:{size:80}}),
    ]);
    expect(responses.map(response=>response.status)).toEqual([200,200]);
    expect(await (await request('appearance_concurrent',undefined,'GET')).json()).toMatchObject({dock:{position:'right',size:80,iconSize:40,autoHide:false}});
    expect((await repository.settingsSnapshot('appearance_concurrent')).revision).toBe(2);
  });
  it('rejects invalid and unauthorized patches before a durable mutation',async()=>{
    for(const body of [{},{ownerId:'victim',dock:{position:'left'}},{dock:{size:1}},{background:{type:'gradient',from:'red'}},{dock:{unexpected:true}}]){
      expect((await request('appearance_validation',body)).status).toBe(400);
    }
    expect((await request('appearance_validation',{dock:{position:'left'}},'PATCH',false)).status).toBe(401);
    expect((await request('appearance_validation',{iconStyle:'x'.repeat(140_000)})).status).toBe(413);
    expect((await repository.settingsSnapshot('appearance_validation')).revision).toBe(0);
  });
});
