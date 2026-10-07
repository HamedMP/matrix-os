import {expect,it,vi} from 'vitest';
import {BotToolRequestSchema} from '@matrix-os/contracts';
import {createManagedPiOwnerTools} from '../../../packages/gateway/src/chat/managed-pi-owner-tools.js';
import {createBotTools} from '../../../packages/bot-runtime/src/tools.js';
import type {ManagedPiRuntimeBinding} from '../../../packages/gateway/src/bots/runtime-registry.js';
const binding={kind:'managed_chat',ownerId:'owner_qa',chatId:'chat_qa',runId:'run_qa',runtimeHandle:`runtime_${'a'.repeat(32)}`,executionGeneration:'1',capabilities:['mail.read'],workspace:{kind:'chat_workspace'},rootFingerprint:'a'.repeat(64)} as ManagedPiRuntimeBinding;
it('exposes retained mail only when runtime authority is wired and read schema is exact',async()=>{
 const read=vi.fn(async()=>({sources:[{id:'account'}]}));const controller=new AbortController();
 const tools=createManagedPiOwnerTools({authority:async()=>({permissionMode:'supervised'}),signalFor:()=>controller.signal,mail:read});
 expect(tools.capabilities).toEqual(['mail.read']);await tools.open(binding,()=>{});
 const request=BotToolRequestSchema.parse({toolCallId:'mail_qa',capability:'mail.read',args:{appId:'edition',action:'sources',payload:{}}});
 const result=await tools.dispatch(binding,request,controller.signal);expect(result.ok).toBe(true);expect(JSON.stringify(result)).toContain('EXTERNAL_UNTRUSTED_CONTENT');
 expect(read).toHaveBeenCalledWith('owner_qa',request.args,expect.any(AbortSignal));
 expect(BotToolRequestSchema.safeParse({...request,args:{appId:'edition',action:'cleanup-commit',payload:{planId:'one',revision:0}}}).success).toBe(false);
 expect(BotToolRequestSchema.safeParse({...request,args:{...request.args,ownerId:'other'}}).success).toBe(false);
 const modelTools=createBotTools({capabilities:['mail.read'],broker:{tool:(request:Parameters<typeof tools.dispatch>[1])=>tools.dispatch(binding,request,controller.signal)} as never,state:{waitingForPerson:false,effectUnknown:false}});
 expect(modelTools.map(t=>t.name)).toEqual(['read_mail_archive']);
 expect(modelTools[0]!.parameters.type).toBe('object');
 const modelResult=await modelTools[0]!.execute('native_mail_call',request.args,controller.signal);expect(JSON.stringify(modelResult)).toContain('EXTERNAL_UNTRUSTED_CONTENT');expect(read).toHaveBeenCalledTimes(2);
 controller.abort();await expect(tools.dispatch(binding,{...request,toolCallId:'mail_again'},controller.signal)).rejects.toThrow();expect(read).toHaveBeenCalledTimes(2);await tools.closeRun(binding.runId);
});
it('rechecks run authority after mail returns and fails safely for large or unavailable results',async()=>{
 const authority=vi.fn(async()=>({permissionMode:'full_access'}));const read=vi.fn(async()=>({text:'x'.repeat(200*1024)}));
 const tools=createManagedPiOwnerTools({authority,signalFor:()=>new AbortController().signal,mail:read});await tools.open(binding,()=>{});
 const request=BotToolRequestSchema.parse({toolCallId:'mail_large',capability:'mail.read',args:{appId:'folio',action:'message',payload:{id:'one'}}});
 await expect(tools.dispatch(binding,request,new AbortController().signal)).rejects.toThrow();
 read.mockImplementationOnce(async()=>{authority.mockResolvedValue({permissionMode:'disabled'});return{text:'private'};});
 await expect(tools.dispatch(binding,{...request,toolCallId:'mail_revoked'},new AbortController().signal)).rejects.toThrow();await tools.closeRun(binding.runId);
});
it('defaults native article reads to explicit bounded pages even with worst escaped text',async()=>{
 const read=vi.fn(async(_owner:string,input:any)=>({contentVersion:'version1',contentChunk:{encoding:'json',offset:input.payload.contentOffset,nextOffset:16_000,totalLength:1_000_000,text:'\u0000'.repeat(input.payload.contentLimit)}}));
 const tools=createManagedPiOwnerTools({authority:async()=>({permissionMode:'full_access'}),signalFor:()=>new AbortController().signal,mail:read});await tools.open(binding,()=>{});
 const model=createBotTools({capabilities:['mail.read'],broker:{tool:(request:any)=>tools.dispatch(binding,request,new AbortController().signal)} as never,state:{waitingForPerson:false,effectUnknown:false}})[0]!;
 const result=await model.execute('chunk1',{appId:'edition',action:'message',payload:{id:'one'}},new AbortController().signal);
 expect(read.mock.calls[0]![1].payload).toEqual({id:'one',contentOffset:0,contentLimit:16_000});
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(192*1024);expect(JSON.stringify(result)).toContain('nextOffset');
 expect(model.description).toContain('contentVersion');await tools.closeRun(binding.runId);
});
it('caps an explicit native page request to the transport-safe chunk size',async()=>{
 const read=vi.fn(async(_owner:string,input:any)=>({contentVersion:'version1',contentChunk:{encoding:'json',offset:0,nextOffset:input.payload.contentLimit,totalLength:50000,text:'\u0000'.repeat(input.payload.contentLimit)}}));
 const tools=createManagedPiOwnerTools({authority:async()=>({permissionMode:'full_access'}),signalFor:()=>new AbortController().signal,mail:read});await tools.open(binding,()=>{});
 const request=BotToolRequestSchema.parse({toolCallId:'explicit_chunk',capability:'mail.read',args:{appId:'edition',action:'message',payload:{id:'one',contentLimit:24_000}}});
 const result=await tools.dispatch(binding,request,new AbortController().signal);expect(read.mock.calls[0]![1].payload.contentLimit).toBe(16_000);expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(192*1024);await tools.closeRun(binding.runId);
});
