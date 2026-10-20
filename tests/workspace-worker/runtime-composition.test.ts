import { describe, expect, it, vi } from 'vitest';
const {drivers,runs}=vi.hoisted(()=>({drivers:vi.fn(),runs:vi.fn(async()=>({accepted:true}))}));
vi.mock('cloudflare:workers',()=>({DurableObject:class {constructor(protected ctx:unknown,protected env:unknown){}}}));
vi.mock('@cloudflare/sandbox',()=>({DirectoryBackup:class {},DirectoryBackupGateway:class {}}));
vi.mock('../../packages/workspace-worker/src/runtime/native-driver.js',()=>({NativeRuntimeDriver:class {constructor(...args:unknown[]){drivers(...args);}}}));
vi.mock('../../packages/workspace-worker/src/runtime/lifecycle.js',()=>({RuntimeLifecycle:class {run=runs;}}));
import { WorkspaceRuntime, type RuntimeConnection } from '../../packages/workspace-worker/src/runtime/durable-object.js';

describe('runtime credential composition',()=>{
  it('does not mutate a running container before resolving an execution owner',()=>{
    class Runtime extends WorkspaceRuntime {protected async openRuntimeConnection():Promise<RuntimeConnection>{throw new Error('unused');}}
    const container={running:true,setInactivityTimeout:vi.fn()};
    const ctx={container,blockConcurrencyWhile:(action:()=>Promise<unknown>)=>action()};
    new Runtime(ctx as never,{});
    expect(container.setInactivityTimeout).not.toHaveBeenCalled();
  });
  it('injects the connection-owned resolver into the native driver and closes the connection',async()=>{
    const resolver=vi.fn(); const close=vi.fn(async()=>undefined);
    const connection={store:{bindRuntime:vi.fn()},resolveCredentials:resolver,close} as unknown as RuntimeConnection;
    class Runtime extends WorkspaceRuntime {protected async openRuntimeConnection(){return connection;}}
    const ctx={container:{running:false},id:{toString:()=> 'runtime-a'},exports:{DirectoryBackupGateway:{}},storage:{setAlarm:vi.fn()}};
    const runtime=new Runtime(ctx as never,{});
    await runtime.run({ownerId:'owner_a',jobId:'job',type:'wake'});
    expect(drivers.mock.calls.at(-1)?.[6]).toBe(resolver);
    expect(connection.store.bindRuntime).toHaveBeenCalledWith('runtime-a','owner_a'); expect(close).toHaveBeenCalledOnce();
  });
});
