import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createRoutineCreationLatch } from '../../packages/gateway/src/chat/routine-creation-latch.js';
import { createClaudeRoutineExecution } from '../../packages/gateway/src/chat/claude-routine-execution.js';
import { proposal } from './bots/routine-cli-request-support.js';
import { input,setup,ready } from './claude-native-session-fixture.js';
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close();});
const legacyContext = { version: 1, chats: [], requestHash: 'a'.repeat(64), routineCreation: 'matrix' } as const;

async function flow(options: { legacy?: boolean; schedulingAllowed?: boolean } = {}) {
 const i = { ...input(), permissionMode: 'full_access', ...(options.legacy ? { context: { ...legacyContext, chats: [] } } : {}) };
 const latch = createRoutineCreationLatch(i), { children, turn } = setup();
 const phase = turn(i, { creationPolicy: latch, schedulingAllowed: options.schedulingAllowed ?? true });
 await ready();
 let calls = 0;
 const server = createServer((_req, res) => {
  calls++;
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ v: 1, error: { code: 'unavailable', message: 'Routine requests are temporarily unavailable.' } }));
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));closers.push(()=>new Promise(done=>server.close(()=>done())));
 const authorize = vi.fn(async () => true);
 const execution=createClaudeRoutineExecution({input:i,signal:i.signal,current:()=>true,publish:()=>{},cwd:process.cwd(),homePath:process.cwd(),
  binPath:resolve('packages/sync-client/bin/matrix.mjs'),endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/routine-cli/execute`,
  runtime:{registerChat:async()=>({authorize,issue:async()=>({takeToken:()=>`rcli_${'A'.repeat(43)}`}),cancel:async()=>{},revoke:async()=>{},narrowNativeMode:()=>{}})} as never});
 closers.push(execution.close);
 const command=`matrix routines propose --input - --request-id de000000-0000-4000-8000-000000000501 <<'MATRIX_ROUTINE_JSON'\n${JSON.stringify(proposal)}\nMATRIX_ROUTINE_JSON`;
 const cron=(id:string)=>{const args={cron:'* * * * *',prompt:'native scheduled prompt',recurring:true};children[0]!.emitFrame({type:'assistant',message:{content:[{type:'tool_use',id,name:'CronCreate',input:args}]}});children[0]!.toolHook('CronCreate',id,args);};
 const denied=(id:string)=>children[0]!.frames.find(f=>f.response?.request_id?.startsWith(`callback_${id}`))?.response.response.hookSpecificOutput?.permissionDecision==='deny';
 return {phase,children,cron,denied,authorize,calls:()=>calls,propose:()=>execution.execute(command,i.signal)};
}
it.each([
 { title: 'ordinary Claude', nativeDenied: false },
 { title: 'a legacy explicit Matrix intent', legacy: true, nativeDenied: true },
 { title: 'an unavailable native scheduler', schedulingAllowed: false, nativeDenied: true },
])('rejects a published CLI proposal before owner action for $title', async ({ nativeDenied, ...options }) => {
 const f = await flow(options);
 await f.propose();
 f.cron('native_attempt'); await ready();
 const denied = f.denied('native_attempt');
 f.children[0]!.result(); await f.phase.promise;
 expect(f.authorize).not.toHaveBeenCalled();
 expect(f.calls()).toBe(0);
 expect(denied).toBe(nativeDenied);
});
it('a retained native due phase ignores the historical creation choice', () => {
 const due = createRoutineCreationLatch({
  ...input(), context: { ...legacyContext, chats: [] },
  nativeScheduled: { sourceRunId: 'run_1', sessionId: 'native_1', promptId: 'de000000-0000-4000-8000-000000000001' },
 });
 expect(due.claim('matrix')).toBe(false);
 expect(due.claim('native')).toBe(true);
});
