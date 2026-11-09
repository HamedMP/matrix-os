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
