import { expect, it, vi } from 'vitest';
import { input, setup, ready } from './claude-native-session-fixture.js';
import { createChatRoutineSourceProducer } from '../../packages/gateway/src/chat/routine-chat-source.js';
import { routineActionPolicy } from '../../packages/gateway/src/bots/routine-action-source-registry.js';
it('blocks native CronCreate before its effect for an explicit Matrix creation flow',async()=>{
 const {children,turn}=setup(); const phase=turn({...input(),context:{version:1,requestHash:'a'.repeat(64),chats:[],routineCreation:'matrix'}});await ready();
 const child=children[0]!,args={cron:'* * * * *',prompt:'native scheduled prompt',recurring:true};
 child.emitFrame({type:'assistant',message:{content:[{type:'tool_use',id:'wrong_engine',name:'CronCreate',input:args}]}});
 child.toolHook('CronCreate','wrong_engine',args);await ready();
 expect(child.frames.find(f=>f.response?.request_id?.startsWith('callback_wrong_engine')).response.response.hookSpecificOutput?.permissionDecision).toBe('deny');
 child.result();await phase.promise;
});
it.each([
 { provider: 'claude' as const, legacy: false, expected: 'deny' },
 { provider: 'claude' as const, legacy: true, expected: 'deny' },
 { provider: 'hermes' as const, legacy: false, expected: 'deny' },
 { provider: 'matrix_pi' as const, legacy: false, expected: 'ask' },
 { provider: 'pi' as const, legacy: false, expected: 'ask' },
 { provider: 'codex' as const, legacy: false, expected: 'ask' },
])('routes new proposals by the admitted $provider source even with legacy choice $legacy', ({ provider, legacy, expected }) => {
 const run = input();
 const binding = createChatRoutineSourceProducer({
  input: { ...run, ...(legacy ? { context: { version: 1, requestHash: 'a'.repeat(64), chats: [], routineCreation: 'matrix' } } : {}) },
  computerId: 'computer', signal: run.signal, publish: () => {}, current: () => true, provider,
 });
 const { source, readPolicy } = binding.producer;
 expect(routineActionPolicy(source, readPolicy(), 'propose')).toBe(expected);
 expect(routineActionPolicy(source, readPolicy(), 'read')).toBe('allow');
 expect(routineActionPolicy(source, readPolicy(), 'control')).toBe('ask');
});
it('does not bind a previous Full Access lease in a retained native due phase',()=>{
 const bindFullAccess=vi.fn();const i={...input(),permissionMode:'full_access',nativeScheduled:{sourceRunId:'run_previous',sessionId:'native_1',promptId:'de000000-0000-4000-8000-000000000001'}};
 createChatRoutineSourceProducer({input:i,computerId:'computer',signal:i.signal,publish:()=>{},current:()=>true,bindFullAccess});
 expect(bindFullAccess).not.toHaveBeenCalled();
});
it('keeps a confirmed older native job and its List/Delete controls through a later Matrix flow',async()=>{
 const {children,turn,scheduled}=setup();const first=turn();await ready();children[0]!.createJob();children[0]!.result();await first.promise;
 const next=turn({...input('run_matrix'),resumeState:{sessionId:'native_1'},context:{version:1,requestHash:'a'.repeat(64),chats:[],routineCreation:'matrix'}});await ready();
 const child=children[0]!;
 for(const name of ['CronList','CronDelete']){
  const args=name==='CronDelete'?{id:'abcdef01'}:{};const id=`existing_${name}`;
  child.emitFrame({type:'assistant',message:{content:[{type:'tool_use',id,name,input:args}]}});child.toolHook(name,id,args);await ready();
  expect(child.frames.find(f=>f.response?.request_id?.startsWith(`callback_${id}`)).response.response.hookSpecificOutput?.permissionDecision).not.toBe('deny');
 }
 child.result();await next.promise;expect(child.kill).not.toHaveBeenCalled();child.prompt();await ready();expect(scheduled).toHaveBeenCalledOnce();
});
