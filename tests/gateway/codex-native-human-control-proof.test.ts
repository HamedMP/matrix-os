import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { nativeCodexConfigurationFingerprint } from '../../packages/gateway/src/coding-agents/native-codex-configuration-fingerprint.mjs';


type HumanEvent = { type: string; approvalId?: string; requestId?: string; questions?: Array<{ questionId: string }> };

function ownRunner(child: ChildProcess) {
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  // The detached group belongs exclusively to this fixture: runner plus its fake
  // provider. A forced runner exit must not strand that provider.
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return; // Failed spawn has no process to signal.
    try { process.kill(-child.pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  return {
    assertStarted() { if (spawnError) throw spawnError; },
    async stop() {
      let force: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        signal('SIGTERM');
        await Promise.race([closed, new Promise<never>((_, reject) => {
          force = setTimeout(() => { try { signal('SIGKILL'); } catch (error) { reject(error); } }, 1500);
          deadline = setTimeout(() => reject(new Error('Owned runner group did not close')), 5000);
        })]);
      } finally { clearTimeout(force); clearTimeout(deadline); }
    },
  };
}

async function lines(path: string) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function control(path: string, value: unknown): Promise<{ ok: boolean; replayed?: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Control timeout')));
    socket.on('error', reject); socket.on('data', chunk => { data += chunk; });
    socket.on('connect', () => socket.end(JSON.stringify(value)));
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
  });
}

it.each(['approval', 'input', 'defer_input'] as const)('rechecks native %s at the final child boundary', async type => {
  for (const mode of ['off', 'marker', 'principal', 'unchanged', 'non-native'] as const) {
    const home = await mkdtemp('/tmp/codex-human-proof-');
    let owned: ReturnType<typeof ownRunner> | undefined;
    try {
    const events = join(home, 'events.jsonl'), trace = join(home, 'trace.jsonl');
    const settings = join(home, 'system/ai-providers/settings.json');
    const accountPath = join(home, 'synthetic-account.json');
    const principal = { type: 'chatgpt', email: 'owner@example.test', id: 'synthetic-owner' };
    const fingerprint = createHash('sha256').update(JSON.stringify({ principal })).digest('hex');
    const row = { id: 'codex', harness: 'codex', enabled: true, accessSourceId: 'owner_openai_profile', selectedAccountId: 'owner_codex', nativeAccountGeneration: fingerprint, nativeAccountConsentRevision: 1, route: { kind: 'fixed', providerId: 'openai', modelId: 'model' } };
    await mkdir(join(home, 'system/ai-providers'), { recursive: true });
    await writeFile(settings, JSON.stringify({ harnesses: [row] }));
    await writeFile(accountPath, JSON.stringify(principal));
    const fake = join(home, 'fake.mjs');
    await writeFile(fake, `import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); appendFileSync(${JSON.stringify(trace)},JSON.stringify(m)+'\\n');
 const send=result=>console.log(JSON.stringify({id:m.id,result}));
 if(m.method==='initialize') send({});
 else if(m.method==='config/read') send({config:{model_provider:'openai',chatgpt_base_url:'https://chatgpt.com/backend-api/',cli_auth_credentials_store:'keyring'}});
 else if(m.method==='account/read') send({account:JSON.parse(readFileSync(${JSON.stringify(accountPath)},'utf8'))});
 else if(m.method==='thread/start') send({thread:{id:'thread'},modelProvider:'openai'});
 else if(m.method==='turn/start') {
  send({turn:{id:'turn'}});
  console.log(JSON.stringify({id:'human-request',method:${JSON.stringify(type === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput')},params:{threadId:'thread',turnId:'turn',itemId:'item',availableDecisions:['accept','cancel'],questions:[{id:'question',header:'Choose',question:'Continue?',options:[{label:'Yes',description:'Continue'}],isOther:false,isSecret:false}]}}));
 } else if(m.method==='turn/interrupt') send({});
}
`);
    const config = { prompt: 'Synthetic human control', approvalPolicy: 'on-request', sandbox: 'workspace-write', writableRoots: [home], ...(mode === 'non-native' ? {} : { nativeSubscription: true, expectedNativePrincipal: fingerprint, expectedNativeConsent: { revision: 1, harnessInstanceId: row.id, accountId: row.selectedAccountId, configurationFingerprint: nativeCodexConfigurationFingerprint(row) } }) };
    const child = spawn(process.execPath, [join(process.cwd(), 'packages/gateway/src/coding-agents/codex-app-server-runner.mjs'), events, process.version.slice(1), process.execPath, fake, Buffer.from(JSON.stringify(config)).toString('base64')], { cwd: home, detached: true, env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex') }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = ownRunner(child);
    child.stdout.resume(); child.stderr.resume();
      let event: HumanEvent | undefined;
      await expect.poll(async () => { owned!.assertStarted(); event = (await lines(events)).find(row => row.type === (type === 'approval' ? 'matrix.codex.approval.requested' : 'matrix.codex.user_input.requested')); return !!event; }, { timeout: 10000 }).toBe(true);
      if (!event) throw new Error('Missing human request event');
      const questionId = event.questions?.[0]?.questionId;
      if (type === 'approval' ? !event.approvalId : !event.requestId || !questionId) throw new Error('Malformed human request event');
      // Initial admission and turn succeeded. Owner state changes before delivery
      // of the already-admitted gateway human response to this child socket.
      if (mode === 'off' || mode === 'non-native') await writeFile(settings, JSON.stringify({ harnesses: [{ ...row, enabled: false }] }));
      if (mode === 'marker') await writeFile(join(home, 'system/ai-providers/codex-execution-revocation.json'), '{}');
      if (mode === 'principal') await writeFile(accountPath, JSON.stringify({ ...principal, id: 'replacement' }));
      const payload = { type, clientRequestId: 'req_human', ...(type === 'approval' ? { approvalId: event.approvalId, decision: 'approve' } : { requestId: event.requestId, ...(type === 'input' ? { structuredAnswers: { [questionId!]: ['Yes'] } } : {}) }) };
      const allowed = mode === 'unchanged' || mode === 'non-native';
      expect(await control(events.replace('.jsonl', '.sock'), payload)).toMatchObject({ ok: allowed });
      // This RPC is a barrier: the fake provider records any preceding human response.
      expect(await control(events.replace('.jsonl', '.sock'), { type: 'interrupt', clientRequestId: 'req_interrupt' })).toMatchObject({ ok: true });
      const received = (await lines(trace)).filter(row => row.id === 'human-request');
      expect(received).toHaveLength(allowed ? 1 : 0);
      if (allowed) {
        await writeFile(settings, JSON.stringify({ harnesses: [{ ...row, enabled: false }] }));
        expect(await control(events.replace('.jsonl', '.sock'), payload)).toMatchObject({ ok: true, replayed: true });
        expect((await lines(trace)).filter(row => row.id === 'human-request')).toHaveLength(1);
      }
    } finally {
      try { await owned?.stop(); }
      finally { await rm(home, { recursive: true, force: true }); }
    }
  }
}, 60000);
