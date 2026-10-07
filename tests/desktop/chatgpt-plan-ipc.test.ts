import { describe, expect, it, vi } from 'vitest';
import { registerChatgptPlanIpc } from '../../desktop/src/main/ipc/chatgpt-plan';
const status={state:'disconnected',scope:'this_device',models:[],grant:{revision:0,enabled:false,background:false},bridgeConnected:false,revocation:'none'};
const input={runtimeSlot:'primary',authGeneration:1};
function fixture(){const handlers=new Map<string,(e:unknown,x:unknown)=>Promise<unknown>>();const service={status:vi.fn(async()=>status),connect:vi.fn(async()=>status),cancel:vi.fn(async()=>status),disconnect:vi.fn(async()=>status),refreshModels:vi.fn(async()=>status),setGrant:vi.fn(async()=>status)};registerChatgptPlanIpc({handle:(c,f)=>handlers.set(c,f)},service as never,e=>e==='main');return {handlers,service};}
describe('subscription native IPC authority',()=>{
 it('rejects embed/other frame callers and credential/provider URL inputs before work',async()=>{const x=fixture();const handler=x.handlers.get('chatgpt-plan:connect')!;await expect(handler('embed',{...input,purpose:'personal_local'})).rejects.toThrow('invalid request');await expect(handler('main',{...input,purpose:'personal_local',accessToken:'private'})).rejects.toThrow('invalid request');expect(x.service.connect).not.toHaveBeenCalled();});
 it('validates native results and resolves service methods at registration time',async()=>{const x=fixture();expect(await x.handlers.get('chatgpt-plan:status')!('main',input)).toEqual(status);x.service.status.mockResolvedValueOnce({...status,accessToken:'private'} as never);await expect(x.handlers.get('chatgpt-plan:status')!('main',input)).rejects.toThrow('internal error');expect(()=>registerChatgptPlanIpc({handle:vi.fn()},{} as never,()=>true)).toThrow();});
});
import { readFileSync } from 'node:fs';
it('boots native subscription service, main-frame IPC and shutdown drain in shipped Electron',()=>{const main=readFileSync('desktop/src/main/index.ts','utf8');const shared=readFileSync('desktop/src/shared/ipc-contract.ts','utf8');expect(main).toContain('createNativeChatgptPlanService');expect(main).toContain('registerChatgptPlanIpc(ipcMain');expect(main).toContain('chatgptPlan.dispose()');expect(shared).toContain('...CHATGPT_PLAN_INVOKE');});

it('rejects background delegation at the trusted IPC boundary for this release',async()=>{const x=fixture();await expect(x.handlers.get('chatgpt-plan:set-grant')!('main',{...input,enabled:true,background:true})).rejects.toThrow('invalid request');expect(x.service.setGrant).not.toHaveBeenCalled();});
