import {it,expect,vi} from 'vitest';
import {registerAiUsageIpc} from '../../desktop/src/main/ipc/ai-usage';
it('rejects untrusted senders and renderer-supplied paths before scanning',async()=>{
 let handler!:(event:unknown,input:unknown)=>Promise<unknown>;let trusted=false;
 const scan=vi.fn(async()=>({version:1 as const,events:[],issues:0}));
 const service=registerAiUsageIpc({handle:(_name,fn)=>{handler=fn;}},{home:'/local-user',auth:{getStatus:()=>({signedIn:true,userId:'owner',runtimeSlot:'primary',authGeneration:1})},scan,isTrusted:()=>trusted});
 const input={runtimeSlot:'primary',authGeneration:1};
 await expect(handler({},input)).rejects.toThrow();trusted=true;
 await expect(handler({},{...input,home:'/other'})).rejects.toThrow();expect(scan).not.toHaveBeenCalled();
 expect(await handler({},input)).toEqual({version:1,events:[],issues:0});expect(scan.mock.calls[0][0]).toContain('/local-user/.codex/sessions');await service.dispose();
});
it('discards native scan results after sign-out or a computer generation change',async()=>{
 let handler!:(event:unknown,input:unknown)=>Promise<unknown>;
 let generation=1;let finish!:(data:{version:1;events:[];issues:number})=>void;
 const service=registerAiUsageIpc({handle:(_name,fn)=>{handler=fn;}},{home:'/local-user',auth:{getStatus:()=>({signedIn:true,userId:'owner',runtimeSlot:'primary',authGeneration:generation})},scan:()=>new Promise(resolve=>{finish=resolve;}),isTrusted:()=>true});
 const request=handler({},{runtimeSlot:'primary',authGeneration:1});generation=2;finish({version:1,events:[],issues:0});await expect(request).rejects.toThrow('Usage unavailable');await service.dispose();
});
it('scans the agent folders this Mac is configured to use, not only the defaults',async()=>{
 let handler!:(event:unknown,input:unknown)=>Promise<unknown>;
 const scan=vi.fn(async()=>({version:1 as const,events:[],issues:0}));
 const service=registerAiUsageIpc({handle:(_name,fn)=>{handler=fn;}},{home:'/local-user',roots:{codexRoot:'/custom/codex',claudeRoot:'/custom/claude'},auth:{getStatus:()=>({signedIn:true,userId:'owner',runtimeSlot:'primary',authGeneration:1})},isTrusted:()=>true,scan});
 await handler({},{runtimeSlot:'primary',authGeneration:1});
 expect(scan.mock.calls[0][0]).toEqual(['/custom/claude/projects','/custom/codex/sessions','/custom/codex/archived_sessions']);await service.dispose();
});
it('starts the new scan once a cancelled one from the previous computer has finished',async()=>{
 let handler!:(event:unknown,input:unknown)=>Promise<unknown>;let generation=1;
 const scan=vi.fn((_roots:string[],signal:AbortSignal)=>generation===1
  ?new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>setTimeout(()=>reject(new Error('aborted')),5)))
  :Promise.resolve({version:1 as const,events:[],issues:generation}));
 const service=registerAiUsageIpc({handle:(_name,fn)=>{handler=fn;}},{home:'/local-user',auth:{getStatus:()=>({signedIn:true,userId:'owner',runtimeSlot:'primary',authGeneration:generation})},isTrusted:()=>true,scan:scan as never});
 const first=handler({},{runtimeSlot:'primary',authGeneration:1});
 service.cancel();generation=2;
 await expect(handler({},{runtimeSlot:'primary',authGeneration:2})).resolves.toEqual({version:1,events:[],issues:2});
 await expect(first).rejects.toThrow('Usage unavailable');expect(scan).toHaveBeenCalledTimes(2);await service.dispose();
});
