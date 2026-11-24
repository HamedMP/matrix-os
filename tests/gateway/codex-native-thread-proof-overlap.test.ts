import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { nativeCodexConfigurationFingerprint } from '../../packages/gateway/src/coding-agents/native-codex-configuration-fingerprint.mjs';

// A new native Codex chat proves the owner's account and starts its thread
// concurrently: thread/start only loads local state and MCP servers, while
// billing starts at turn/start, which waits for both and re-proves first.

async function lines(path: string): Promise<Array<Record<string, unknown>>> {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function run(mode: 'healthy' | 'principal_mismatch' | 'thread_fails') {
  const home = await mkdtemp('/tmp/codex-proof-overlap-');
  try {
    const events = join(home, 'events.jsonl'), trace = join(home, 'trace.jsonl');
    const principal = { type: 'chatgpt', email: 'owner@example.test', id: 'synthetic-owner' };
    const fingerprint = createHash('sha256').update(JSON.stringify({ principal })).digest('hex');
    const row = { id: 'codex', harness: 'codex', enabled: true, accessSourceId: 'owner_openai_profile', selectedAccountId: 'owner_codex', nativeAccountGeneration: fingerprint, nativeAccountConsentRevision: 1, route: { kind: 'fixed', providerId: 'openai', modelId: 'model' } };
    await mkdir(join(home, 'system/ai-providers'), { recursive: true });
    await writeFile(join(home, 'system/ai-providers/settings.json'), JSON.stringify({ harnesses: [row] }));
    const served = mode === 'principal_mismatch' ? { ...principal, id: 'replacement' } : principal;
    const fake = join(home, 'fake.mjs');
    // account/read is held until thread/start has been received and answered
    // (or 2s pass), so a sequential runner is observable as threadStarted=false.
    await writeFile(fake, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const log=v=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(v)+'\\n');
let threadDone=false, heldAccount;
const send=(id,result)=>console.log(JSON.stringify({id,result}));
const replyAccount=id=>{log({event:'account_reply',threadStarted:threadDone});send(id,{account:${JSON.stringify(served)}});};
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); log({event:'received',method:m.method});
 if(m.method==='initialize') send(m.id,{});
 else if(m.method==='config/read') send(m.id,{config:{model_provider:'openai',chatgpt_base_url:'https://chatgpt.com/backend-api/',cli_auth_credentials_store:'keyring'}});
 else if(m.method==='account/read') { if(threadDone) replyAccount(m.id); else { heldAccount=m.id; setTimeout(()=>{ if(heldAccount===m.id){heldAccount=undefined;replyAccount(m.id);} },2000); } }
 else if(m.method==='thread/start') {
  if(${JSON.stringify(mode)}==='thread_fails') console.log(JSON.stringify({id:m.id,error:{code:-32603,message:'synthetic thread failure'}}));
  else send(m.id,{thread:{id:'thread'},modelProvider:'openai'});
  threadDone=true;
  if(heldAccount!==undefined){const id=heldAccount;heldAccount=undefined;replyAccount(id);}
 }
 else if(m.method==='turn/start') { send(m.id,{turn:{id:'turn'}}); console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn',status:'completed',items:[]}}})); }
}
`);
    const config = { prompt: 'Synthetic overlap', approvalPolicy: 'never', sandbox: 'workspace-write', writableRoots: [home], nativeSubscription: true, expectedNativePrincipal: fingerprint, expectedNativeConsent: { revision: 1, harnessInstanceId: row.id, accountId: row.selectedAccountId, configurationFingerprint: nativeCodexConfigurationFingerprint(row) } };
    const child = spawn(process.execPath, [join(process.cwd(), 'packages/gateway/src/coding-agents/codex-app-server-runner.mjs'), events, process.version.slice(1), process.execPath, fake, Buffer.from(JSON.stringify(config)).toString('base64')], { cwd: home, env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), MATRIX_BACKGROUND_AGENT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    const settled = (async () => {
      for (let i = 0; i < 400; i++) {
        if ((await lines(events)).some(event => event.type === 'turn.completed' || event.type === 'turn.failed')) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })();
    await Promise.race([closed, settled]);
    // A failed startup exits by itself; a healthy runner stays up between turns.
    if (mode !== 'healthy') await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const code = await closed;
    return { code, stderr, events: await lines(events), trace: await lines(trace) };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

it('sends thread/start before the account proof resolves and starts the turn only after both', async () => {
  const result = await run('healthy');
  const accountReply = result.trace.find(entry => entry.event === 'account_reply');
  expect(accountReply, result.stderr).toMatchObject({ threadStarted: true });
  const received = result.trace.filter(entry => entry.event === 'received').map(entry => entry.method);
  const turnAt = received.indexOf('turn/start');
  expect(turnAt).toBeGreaterThan(received.indexOf('thread/start'));
  expect(turnAt).toBeGreaterThan(received.indexOf('account/read'));
  const types = result.events.map(event => event.type);
  expect(types).toContain('thread.started');
  expect(types).toContain('turn.completed');
}, 20_000);

it('fails closed when the account proof fails even though thread/start succeeded concurrently', async () => {
  const result = await run('principal_mismatch');
  const received = result.trace.filter(entry => entry.event === 'received').map(entry => entry.method);
  expect(received).toContain('thread/start');
  expect(received).not.toContain('turn/start');
  const types = result.events.map(event => event.type);
  expect(types).not.toContain('thread.started');
  expect(types).toContain('turn.failed');
  expect(result.code).toBe(1);
  expect(result.stderr).not.toMatch(/unhandled/i);
}, 20_000);

it('fails closed when thread/start fails while the account proof succeeds', async () => {
  const result = await run('thread_fails');
  const received = result.trace.filter(entry => entry.event === 'received').map(entry => entry.method);
  expect(received).toContain('account/read');
  expect(received).not.toContain('turn/start');
  const types = result.events.map(event => event.type);
  expect(types).not.toContain('thread.started');
  expect(types).toContain('turn.failed');
  expect(result.code).toBe(1);
  expect(result.stderr).not.toMatch(/unhandled/i);
}, 20_000);
