#!/usr/bin/env node
// Isolated preview only: uses one fixed server-owned test identity, never real user data.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.env.MATRIX_WORKSPACE_TEST_ORIGIN ?? 'http://127.0.0.1:8788';
const token = (await readFile(process.env.MATRIX_WORKSPACE_TEST_TOKEN_FILE, 'utf8')).trim();
const evidence = {at:new Date().toISOString(),environment:process.env.MATRIX_WORKSPACE_TEST_ENVIRONMENT ?? 'wrangler-local',reads:[],phases:[]};
const marker = `checkpoint-${randomUUID()}`;
async function request(path, method = 'GET', body) {
  const start = performance.now();
  const response = await fetch(new URL(path,origin), {method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(15_000), redirect:'error'});
  if (!response.ok) throw new Error(`Preview ${method} ${path} failed (${response.status})`);
  return {ms:Math.round(performance.now()-start),body:await response.json()};
}
const status = async () => (await request('/api/workspace/runtime')).body;
const check = (ok,message) => {if(!ok) throw new Error(message);};
async function waitForState(acceptable, deadlineMs = 240_000) {
  const deadline = Date.now() + deadlineMs; let prior;
  while (Date.now() < deadline) {
    const current = await status();
    if (prior !== current.state) {
      evidence.phases.push({at:Date.now(),state:current.state,generation:current.generation,activeRuns:current.activeRuns});
      console.log(JSON.stringify(evidence.phases.at(-1))); prior=current.state;
    }
    if (acceptable.includes(current.state)) return current;
    if (current.state === 'failed' || current.state === 'interrupting') throw new Error('Native runtime failed; inspect private server logs');
    await delay(1500);
  }
  throw new Error('Runtime state deadline exceeded');
}
async function runTask(message, expected) {
  const started = Date.now();
  const action = {type:'chat',chatId:`chat_${randomUUID().replaceAll('-','')}`,idempotencyKey:randomUUID(),message};
  const queued = await request('/api/workspace/actions','POST',action);
  const chatId = queued.body.chatId;
  console.log(JSON.stringify({phase:'queued',ms:queued.ms}));
  // Ignore previous idle state until the admitted job becomes active.
  const admissionDeadline = Date.now()+30_000;
  while (!(await status()).activeRuns) {check(Date.now()<admissionDeadline,'Queue admission timed out');await delay(500);}
  await waitForState(['ready']);
  const output = await request('/api/files/text?path=spike-result.txt');
  check(output.body.content.includes(expected),'Agent did not preserve the expected workspace value');
  const chat = await request(`/api/chats/${chatId}`);
  check(chat.body.messages.some(item=>item.role==='assistant'),'Missing durable agent result');
  const done = Date.now();
  await waitForState(['sleeping']);
  const metrics = await request('/api/workspace/metrics');
  check(metrics.body.running === false,'Compute did not stop');
  check((await request('/api/files/text?path=spike-result.txt')).body.content === output.body.content,'Saved data unavailable while asleep');
  evidence.phases.push({phase:'completed-and-slept',executionMs:done-started,totalMs:Date.now()-started,revision:output.body.revision});
  return {action,chatId};
}

try {
  check((await request('/api/workspace/metrics')).body.running === false,'Begin with compute stopped');
  evidence.reads.push({path:'bootstrap',...await request('/api/shell/bootstrap')});
  const existing = await request('/api/files/list');
  check(!existing.body.entries.some(item=>item.name==='shared-input.txt'),'Use a fresh isolated preview owner');
  await request('/api/files/text','PUT',{path:'shared-input.txt',content:marker,baseRevision:0});
  check((await request('/api/workspace/metrics')).body.running === false,'A data write woke compute');
  const first = await runTask(`This is an isolated Matrix runtime verification. Use Read to read shared-input.txt from your home. Use Bash to sleep 20 seconds. Use Write to save that exact input value to both spike-private-sentinel.txt and spike-result.txt in your home. Reply only with completion. Do not perform other work.`,marker);
  // The private sentinel was never projected into shared file APIs. Only the
  // native R2 checkpoint can restore it into a replacement Linux container.
  const second = await runTask('Read spike-private-sentinel.txt in your home. Preserve its exact value and use Write to save spike-result.txt with that value followed by a newline and RESTORED_NATIVE_CONTAINER. Reply only with completion. Do not perform other work.',`${marker}\nRESTORED_NATIVE_CONTAINER`);
  await request('/api/workspace/actions','POST',second.action);
  await delay(3000);
  check((await request('/api/workspace/metrics')).body.running === false,'Duplicate delivery restarted compute');
  evidence.result={passed:true,sharedInputHydrated:true,nativePrivateFileRestored:true,duplicateDidNotWake:true,browserAttached:false};
  evidence.chatIds=[first.chatId,second.chatId];
  console.log(JSON.stringify(evidence.result));
} catch (error) {
  evidence.result={passed:false,error:error instanceof Error?error.message:'UnknownError'};
  process.exitCode=1; console.error(JSON.stringify(evidence.result));
} finally {
  await writeFile(process.env.MATRIX_WORKSPACE_TEST_OUTPUT ?? '/tmp/matrix-workspace-evidence.json',JSON.stringify(evidence,null,2),{mode:0o600});
}
