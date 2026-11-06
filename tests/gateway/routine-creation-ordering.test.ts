import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createRoutineCreationLatch } from '../../packages/gateway/src/chat/routine-creation-latch.js';
import { createClaudeRoutineExecution } from '../../packages/gateway/src/chat/claude-routine-execution.js';
import { createChatRoutineSourceProducer } from '../../packages/gateway/src/chat/routine-chat-source.js';
import { routineActionPolicy } from '../../packages/gateway/src/bots/routine-action-source-registry.js';
import { proposal } from './bots/routine-cli-claude-support.js';
import { input,setup,ready } from './claude-native-session-fixture.js';
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close();});
async function until(check:()=>boolean){for(let n=0;n<500&&!check();n++)await new Promise(r=>setTimeout(r,10));expect(check()).toBe(true);}
async function flow(status=200){
 const i={...input(),permissionMode:'full_access'},latch=createRoutineCreationLatch(i),{children,turn}=setup();
 const phase=turn(i,{creationPolicy:latch});await ready();
 let calls=0,answer:(allowed:boolean)=>void=()=>{};
 const modes:string[]=[];
 const server=createServer((_req,res)=>{calls++;res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify({v:1,error:{code:'unavailable',message:'Routine requests are temporarily unavailable.'}}));});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));closers.push(()=>new Promise(done=>server.close(()=>done())));
 const authorize=vi.fn(async()=>{const mode=routineActionPolicy(source.producer.source,source.producer.readPolicy(),'propose');modes.push(mode);return mode==='ask'?await new Promise<boolean>(r=>{answer=r;}):mode==='allow';});
 const source=createChatRoutineSourceProducer({input:i,computerId:'computer_one',signal:i.signal,current:()=>true,publish:()=>{},creationPolicy:latch,
  bindFullAccess:()=>({revision:1,current:()=>true,release:()=>{},validateWithin:async()=>true}) as never});
 const execution=createClaudeRoutineExecution({input:i,signal:i.signal,current:()=>true,publish:()=>{},cwd:process.cwd(),homePath:process.cwd(),creationPolicy:latch,
  binPath:resolve('packages/sync-client/bin/matrix.mjs'),endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/routine-cli/execute`,
  runtime:{registerChat:async()=>({authorize,issue:async()=>({takeToken:()=>`rcli_${'A'.repeat(43)}`}),cancel:async()=>{},revoke:async()=>{},narrowNativeMode:source.narrowNativeMode})} as never});
 closers.push(execution.close);
 const command=`matrix routines propose --input - --request-id de000000-0000-4000-8000-000000000501 <<'MATRIX_ROUTINE_JSON'\n${JSON.stringify(proposal)}\nMATRIX_ROUTINE_JSON`;
 const cron=(id:string)=>{const args={cron:'* * * * *',prompt:'native scheduled prompt',recurring:true};children[0]!.emitFrame({type:'assistant',message:{content:[{type:'tool_use',id,name:'CronCreate',input:args}]}});children[0]!.toolHook('CronCreate',id,args);};
 const denied=(id:string)=>children[0]!.frames.find(f=>f.response?.request_id?.startsWith(`callback_${id}`))?.response.response.hookSpecificOutput?.permissionDecision==='deny';
 return {i,latch,phase,children,cron,denied,modes,authorize,answer:(v:boolean)=>answer(v),calls:()=>calls,propose:()=>execution.execute(command,i.signal)};
}
it('actual native Cron hook first blocks actual published CLI proposal before owner action/effect',async()=>{
 const f=await flow();f.cron('native_first');await ready();expect(f.denied('native_first')).toBe(false);expect(f.latch.current()).toBe('native');
 await f.propose();expect(f.authorize).not.toHaveBeenCalled();expect(f.calls()).toBe(0);expect(f.latch.current()).toBe('native');
 f.children[0]!.result();await f.phase.promise;
});
it('actual legacy proposal holds exact-operation ASK even under Full Access and blocks Cron after denial',async()=>{
 const f=await flow();const pending=f.propose();await until(()=>f.modes.length===1);expect(f.modes).toEqual(['ask']);expect(f.latch.current()).toBe('matrix');
 f.cron('during_approval');await ready();expect(f.denied('during_approval')).toBe(true);expect(f.calls()).toBe(0);
 f.answer(false);await pending;f.cron('after_denial');await ready();expect(f.denied('after_denial')).toBe(true);expect(f.calls()).toBe(0);
 f.children[0]!.result();await f.phase.promise;
});
it('an unknown actual CLI HTTP mutation keeps Matrix claimed and never falls back to native',async()=>{
 const f=await flow(503);const pending=f.propose();await until(()=>f.modes.length===1);f.answer(true);await pending;
 expect(f.calls()).toBe(1);expect(f.latch.current()).toBe('matrix');f.cron('after_unknown');await ready();expect(f.denied('after_unknown')).toBe(true);
 f.children[0]!.result();await f.phase.promise;
});
it('a fresh phase resets the claim while due phases start native and never inherit Matrix',()=>{
 const first=createRoutineCreationLatch(input());expect(first.claim('matrix')).toBe(true);expect(first.claim('native')).toBe(false);
 expect(createRoutineCreationLatch(input()).current()).toBeUndefined();
 const due=createRoutineCreationLatch({...input(),context:{version:1,chats:[],requestHash:'a'.repeat(64),routineCreation:'matrix'},nativeScheduled:{sourceRunId:'run_1',sessionId:'native_1',promptId:'de000000-0000-4000-8000-000000000001'}});
 expect(due.current()).toBe('native');expect(due.attestedMatrix).toBe(false);expect(due.claim('matrix')).toBe(false);
});
