import {beforeEach,describe,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({admit:vi.fn(),dispatch:vi.fn(async()=>0),validate:vi.fn(),reconcileOwners:vi.fn(async()=>[]),run:vi.fn(async()=>({accepted:true})),reconcile:vi.fn(),close:vi.fn(async()=>undefined),status:vi.fn(async()=>({placement:'pooled',state:'sleeping'}))}));
vi.mock('../../packages/workspace-worker/src/runtime/durable-object.js',()=>({WorkspaceRuntime:class {}}));
vi.mock('@cloudflare/sandbox',()=>({DirectoryBackupGateway:class {}}));
vi.mock('../../packages/workspace-worker/src/data/repository.js',async importOriginal=>({...await importOriginal<object>(),createPostgresWorkspaceRepository:()=>({db:{},close:f.close})}));
vi.mock('../../packages/workspace-worker/src/data/runtime-store.js',()=>({PostgresRuntimeStore:class {status=f.status;}}));
vi.mock('../../packages/workspace-worker/src/data/compute-admission.js',()=>({PostgresComputeAdmissionStore:class {admit=f.admit;dispatch=f.dispatch;validate=f.validate;reconcileOwners=f.reconcileOwners;runtimeHooks=()=>({});}}));
import worker from '../../packages/workspace-worker/src/index.js';
const job={ownerId:'preview_owner',jobId:'a',type:'wake' as const};
const env={HYPERDRIVE:{connectionString:'postgres://fixture'},WORKSPACE_FILES:{},WORKSPACE_JOBS:{send:vi.fn()},WORKSPACE_RUNTIME:{idFromName:(owner:string)=>owner,get:()=>({run:f.run,reconcile:f.reconcile})},PREVIEW_ENABLED:'1',PREVIEW_TOKEN:'preview_token_at_least_32_bytes_long',PREVIEW_OWNER_ID:'preview_owner'};
beforeEach(()=>{vi.clearAllMocks();f.validate.mockResolvedValue(job);});
describe('Worker compute admission composition',()=>{
 it('requires committed admission before delivering any Queue payload to a runtime',async()=>{
  f.validate.mockResolvedValueOnce(null); const ack=vi.fn(),retry=vi.fn();
  await worker.queue({messages:[{body:job,ack,retry}]} as never,env as never);
  expect(f.validate).toHaveBeenCalledWith(job);expect(f.run).not.toHaveBeenCalled();expect(ack).toHaveBeenCalledOnce();
 });
 it('leaves a failed runtime delivery retryable without settling a hold',async()=>{
  f.run.mockRejectedValueOnce(new Error('ambiguous runtime acknowledgment'));const ack=vi.fn(),retry=vi.fn();
  await worker.queue({messages:[{body:job,ack,retry}]} as never,env as never);
  expect(f.validate).toHaveBeenCalledWith(job);expect(retry).toHaveBeenCalledWith({delaySeconds:60});expect(ack).not.toHaveBeenCalled();
 });
 it('admits before sending and returns canonical admission without inline Chat persistence',async()=>{
  f.admit.mockResolvedValueOnce({job,jobId:'a',state:'queued'});
  const response=await worker.fetch(new Request('https://preview.test/api/workspace/actions',{method:'POST',headers:{authorization:`Bearer ${env.PREVIEW_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({type:'wake'})}),env as never);
  expect(response.status).toBe(202);expect(f.admit).toHaveBeenCalled();expect(f.dispatch).toHaveBeenCalled();
  expect(f.admit.mock.invocationCallOrder[0]).toBeLessThan(f.dispatch.mock.invocationCallOrder[0]);
 });
});
