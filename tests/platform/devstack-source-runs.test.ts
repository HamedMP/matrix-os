import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDevstackHostedAccess } from '../../packages/platform/src/devstack-hosted-access.js';
import { createDevstackRunStore, migrateDevstackRuns } from '../../packages/platform/src/devstack-runs/store.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { loadDevstackPreviewConfig } from '../../packages/platform/src/devstack-runs/config.js';
import { createStage3Publisher, listenStage3Publisher } from '../../scripts/devstack/stage3-publisher.mjs';
import { identifyStage3Source, identifyStage3Target } from '../../scripts/devstack/stage3-source.mjs';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { identifyCheckout } from '../../packages/sync-client/src/cli/commands/devstack-stage3-connect.js';
import { createIsolatedStage3TestRunner } from '../../scripts/devstack/stage3-isolated-runner.mjs';

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error: unknown) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Source-run fixture cleanup failed');
});
const origin = 'https://devstack.matrix-os.com', approvalOrigin = 'https://approve.example.test';

async function fixture(realWorkload = false) {
  if (!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL) throw new Error('Real disposable Postgres is required');
  const { db } = await createTestPlatformDb();
  cleanups.push(() => destroyTestPlatformDb(db));
  await migrateDevstackRuns(db.kysely);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-runs-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging'), mirror = join(root, 'mirror');
  await Promise.all([mkdir(staging, { mode: 0o700 }), mkdir(mirror, { mode: 0o700 })]);
  const git = (...args: string[]) => exec('git', ['-C', staging, ...args], { timeout: 5000 });
  await git('init', '-q'); await writeFile(join(staging, 'example.txt'), 'Baseline'); await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Baseline');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  const main = join(root, 'main');
  await exec('git', ['clone', '-q', staging, main], { timeout: 5000 });
  const target = { owner: 'user_owner', runtime: 'runtime-one', worktree: 'worktree-one', handle: 'dev-one', containerId: 'a'.repeat(64) };
  const identity = await identifyCheckout(main), socketPath = join(root, 'publisher.sock');
  let executions = 0, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = realWorkload ? createIsolatedStage3TestRunner({
    image: (await exec('docker', ['image', 'inspect', 'node:24-bookworm-slim', '--format', '{{index .RepoDigests 0}}'], { timeout:5000 })).stdout.trim(),
    command: ['node', '-e', "console.log('Validated '+require('node:fs').readFileSync('example.txt','utf8'));process.exit(7)"],
  }) : undefined;
  const publisher = createStage3Publisher({ stateDir: join(root, 'state'), enrollment: {
    ...target, sourceIdentity: identity, generation: 'c'.repeat(64), expiresAt: Date.now() + 60_000, base,
    source: { root: staging, identity: await identifyStage3Source(staging), computerId: 'fixture-main' },
    target: { root: mirror, identity: await identifyStage3Target(mirror), handle: target.handle, containerId: target.containerId },
  }, testRevision: async (binding: unknown, revision: string, signal: AbortSignal) => {
    executions++; entered();
    await Promise.race([gate, new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    signal.throwIfAborted();
    if (runner) return runner(binding, revision, signal);
    return { exitCode: 7, log: 'Validated ' + await readFile(join(mirror, 'example.txt'), 'utf8') };
  } });
  const listener = await listenStage3Publisher({ socketPath, publisher });
  cleanups.push(() => listener.close());
  cleanups.push(async () => { release(); });
  let member = true, registered = true;
  const config = loadDevstackPreviewConfig(JSON.stringify({ issuer: 'https://clerk.example.test', previewOrigin: origin,
    operators: [target.owner], targets: [target], publicBrowserOnly: true }), 'stage-three')!;
  function ingress(override: Partial<typeof target> = {}, sourceIdentity = identity) {
    const bound = { ...target, ...override };
    const clerkAuth = createClerkAuth({ verifyToken: async () => ({ sub: bound.owner, sid: 'sess_fixture', azp: approvalOrigin,
      exp: Math.floor(Date.now() / 1000) + 60, iss: 'https://clerk.example.test' }) });
    const access = createDevstackHostedAccess({ config: { ...config, operators: [bound.owner], targets: [bound] }, clerkAuth, approvalClerkAuth: clerkAuth,
      publishableKey: 'pk_test_fixture', isMember: async () => member,
      resolve: async () => registered ? { handle: bound.handle, clerkUserId: bound.owner, containerId: bound.containerId,
        source: 'record', host: '127.0.0.1', port: 4000, shellPort: 3000, status: 'running' } : null,
    }, { MATRIX_DEVSTACK_CLI_PILOT_WORKTREE: bound.worktree,
      MATRIX_DEVSTACK_SOURCE_PUBLISHER: JSON.stringify({ socketPath, identity: sourceIdentity, approvalOrigin }) }, createDevstackRunStore(db.kysely));
    cleanups.push(async () => { await access.close?.(); });
    const app = new Hono(); app.use('*', access.devstackPublicPreview!.middleware); app.route('/', access.devstackCliRoutes!);
    const request = (path: string, init: RequestInit = {}) => app.request(origin + path,
      { ...init, headers: { host: new URL(origin).hostname, ...init.headers } });
    async function grant() {
      const pairing = await request('/devstack/cli/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceIdentity }) });
      const { approvalId, pollSecret } = await pairing.json();
      const approved = await app.request(approvalOrigin + '/devstack/cli/pair/' + approvalId, {
        method: 'POST', headers: { host: new URL(approvalOrigin).hostname, origin: approvalOrigin, cookie: '__session=fixture' },
        body: new URLSearchParams({ worktree: bound.worktree }),
      });
      expect(approved.status).toBe(303);
      const result = await request('/devstack/cli/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollSecret }) });
      return result.json();
    }
    return { access, app, request, grant };
  }
  const delta = (content = 'First') => ({ base, entries: [{ kind: 'file', path: 'example.txt', mode: 420, content: Buffer.from(content).toString('base64') }] });
  return { db, root, main, ingress, delta, mirror, started, release, executions: () => executions, revoke: () => { member = false; }, unregister: () => { registered = false; }, register: () => { registered = true; } };
}

describe('recoverable hosted source publication', () => {
  it('keeps an accepted run after the submitting CLI exits and recovers it from another real CLI process', async () => {
    const f = await fixture(true), ingress = f.ingress();
    const http = serve({ hostname:'127.0.0.1', port:0, fetch:async request => {
      const response = await ingress.app.fetch(request);
      // Fixture human approval uses the actual trusted-origin route. Network,
      // source producer, Postgres, private socket and receiver stay real.
      if (new URL(request.url).pathname === '/devstack/cli/pair' && response.status === 201) {
        const { approvalId } = await response.clone().json();
        const approved = await ingress.app.request(approvalOrigin + '/devstack/cli/pair/' + approvalId, {
          method:'POST', headers:{host:new URL(approvalOrigin).hostname, origin:approvalOrigin, cookie:'__session=fixture'},
          body:new URLSearchParams({worktree:'worktree-one'}),
        });
        expect(approved.status).toBe(303);
      }
      return response;
    } });
    await new Promise<void>(done => http.once('listening', done));
    cleanups.push(async () => { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener unavailable');
    const adapter = join(f.root, 'http-adapter.mjs');
    await writeFile(adapter, `
      import {request} from 'node:http';
      globalThis.fetch = (url, init={}) => new Promise((resolve,reject) => {
        const target=new URL(url);
        if(target.origin!==${JSON.stringify(origin)}) return reject(new Error('Unenrolled fixture origin'));
        const req=request({hostname:'127.0.0.1',port:${address.port},path:target.pathname,method:init.method??'GET',
          headers:{...Object.fromEntries(new Headers(init.headers)),host:target.hostname},signal:init.signal},res=>{
          const chunks=[];let bytes=0;
          res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)req.destroy(new Error('fixture response too large'));else chunks.push(chunk)});
          res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
          res.on('error',reject);
        });req.on('error',reject);req.end(init.body);
      });
    `);
    const home = join(f.root, 'client-home'); await mkdir(home, {mode:0o700});
    const env = {...process.env, HOME:home, USERPROFILE:home, MATRIX_NO_TELEMETRY:'1', NODE_OPTIONS:'--import='+pathToFileURL(adapter).href};
    const cli = resolve('packages/sync-client/bin/matrix.mjs');
    await writeFile(join(f.main, 'example.txt'), 'First');
    const child = spawn(process.execPath, [cli, 'devstack', 'sync', '--hosted', '--json'], {cwd:f.main,env,stdio:['ignore','pipe','pipe']});
    let errors = ''; child.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-8192);});
    const exited = new Promise<void>(done=>child.once('exit',()=>done()));
    cleanups.push(async () => { if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await exited;} });
    expect(await Promise.race([f.started.then(()=>'started'),exited.then(()=>'exited '+errors),delay(8000).then(()=>'timeout '+errors)])).toBe('started');
    child.kill('SIGTERM'); await exited;
    const runId = /DevStack runId: ([a-f0-9-]{36})/.exec(errors)?.[1]; expect(runId).toBeTruthy();
    f.release();
    for(let attempt=0;attempt<100;attempt++){
      const result=await sql<{status:string}>`SELECT status FROM devstack_runs WHERE run_id=${runId}`.execute(f.db.kysely);
      if(result.rows[0]?.status!=='running')break; await delay(10);
    }
    const recovered = await exec(process.execPath,[cli,'devstack','result','--hosted','--run-id',runId!,'--json'],{cwd:f.main,env,timeout:10_000})
      .catch((error: {code:number;stdout:string;stderr:string}) => { expect(error.code).toBe(7); return error; });
    const result = JSON.parse(recovered.stdout).data;
    expect(result).toMatchObject({runId,status:'failed',test:{exitCode:7,log:'Validated First'}});
    expect(result.revision).toBe(result.test.revision);
    expect(f.executions()).toBe(1);
    expect(await readFile(join(f.main,'example.txt'),'utf8')).toBe('First');
    console.log(JSON.stringify({lane:'local-cli-http-postgres-unix-docker-recovery',runId,
      revision:result.revision,status:result.status,test:result.test,executions:f.executions()}));
  }, 20_000);

  it('admits once before replying, retains the actual failing receipt and reads it through a fresh ingress', async () => {
    const f = await fixture(), first = f.ingress();
    const grant = await first.grant();
    expect(grant.binding.sourceRuns).toBe(true);
    const runId = randomUUID(), key = randomBytes(32).toString('hex');
    const headers = { authorization: 'Bearer ' + grant.bearer, 'content-type': 'application/json', 'x-devstack-run-id': runId, 'x-devstack-run-key': key };
    const start = () => first.request('/devstack/cli/source', { method: 'POST', headers, body: JSON.stringify(f.delta()) });
    const submitted = await Promise.all([start(), start()]);
    expect(submitted.map(r => r.status)).toEqual([202, 202]);
    await f.started;
    expect(f.executions()).toBe(1);
    const changed = await first.request('/devstack/cli/source', { method: 'POST', headers, body: JSON.stringify(f.delta('Changed')) });
    expect(changed.status).toBe(409);
    // Re-approving the same bound checkout rotates the CLI bearer, but must
    // not invalidate a previously accepted, bounded durable job.
    await first.grant();
    f.release();
    const second = f.ingress();
    const fresh = await second.grant();
    const readHeaders = { authorization: 'Bearer ' + fresh.bearer, 'x-devstack-run-key': key };
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await second.request('/devstack/cli/source/' + runId, { headers: readHeaders });
      expect(response.status).toBe(200); result = await response.json();
      if (result.status !== 'running') break;
      await delay(10);
    }
    expect(result).toMatchObject({ runId, status: 'failed', receipt: { test: { exitCode: 7, log: 'Validated First' } } });
    expect(result.receipt.test.revision).toBe(result.receipt.revision);
    expect(JSON.stringify(result)).not.toContain(key);
    const stored = await sql<{ key_digest: string; source_receipt: unknown }>`SELECT key_digest, source_receipt FROM devstack_runs WHERE run_id=${runId}`.execute(f.db.kysely);
    expect(stored.rows[0].key_digest).toBe(createHash('sha256').update(key).digest('hex'));
    expect(stored.rows[0].source_receipt).toEqual(result.receipt);
    expect((await second.request('/devstack/cli/source/' + runId, { headers: { ...readHeaders, 'x-devstack-run-key': '0'.repeat(64) } })).status).toBe(404);
    const replay = await second.request('/devstack/cli/source', { method:'POST', headers:{ ...headers, authorization:'Bearer '+fresh.bearer }, body:JSON.stringify(f.delta()) });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({runId,status:'failed',receipt:result.receipt});
    expect(f.executions()).toBe(1);
  });

  it('fences all six binding fields and current membership/registry during result recovery', async () => {
    const f = await fixture(), first = f.ingress(); const grant = await first.grant();
    const runId = randomUUID(), key = randomBytes(32).toString('hex');
    expect((await first.request('/devstack/cli/source', { method: 'POST', headers: { authorization: 'Bearer ' + grant.bearer,
      'content-type': 'application/json', 'x-devstack-run-id': runId, 'x-devstack-run-key': key }, body: JSON.stringify(f.delta()) })).status).toBe(202);
    await f.started; f.release(); await delay(50);
    for (const field of ['owner', 'runtime', 'worktree', 'handle', 'containerId'] as const) {
      const changed = f.ingress({ [field]: field === 'containerId' ? 'f'.repeat(64) : field === 'owner' ? 'user_peer' : 'other-target' });
      const fresh = await changed.grant();
      expect((await changed.request('/devstack/cli/source/' + runId, { headers: { authorization: 'Bearer ' + fresh.bearer, 'x-devstack-run-key': key } })).status).toBe(404);
    }
    const otherSource = f.ingress({}, 'e'.repeat(64)); const fresh = await otherSource.grant();
    expect((await otherSource.request('/devstack/cli/source/' + runId, { headers: { authorization: 'Bearer ' + fresh.bearer, 'x-devstack-run-key': key } })).status).toBe(404);
    const valid = f.ingress(); const renewed = await valid.grant();
    const read = () => valid.request('/devstack/cli/source/' + runId, { headers: { authorization: 'Bearer ' + renewed.bearer, 'x-devstack-run-key': key } });
    f.unregister(); expect((await read()).status).toBe(409);
    f.register();
    f.revoke(); expect((await read()).status).toBe(409);
  });

  it('reports an expired execution as interrupted and never reexecutes an uncertain run after restart', async () => {
    const f = await fixture(), first=f.ingress(), grant=await first.grant();
    const runId=randomUUID(), key=randomBytes(32).toString('hex');
    const headers={authorization:'Bearer '+grant.bearer,'content-type':'application/json','x-devstack-run-id':runId,'x-devstack-run-key':key};
    expect((await first.request('/devstack/cli/source',{method:'POST',headers,body:JSON.stringify(f.delta())})).status).toBe(202);
    await f.started;
    await sql`UPDATE devstack_runs SET lease_until=NOW()-interval '1 second' WHERE run_id=${runId}`.execute(f.db.kysely);
    f.release();await delay(50);
    const restarted=f.ingress(),fresh=await restarted.grant();
    const replay=await restarted.request('/devstack/cli/source',{method:'POST',headers:{...headers,authorization:'Bearer '+fresh.bearer},body:JSON.stringify(f.delta())});
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({runId,runtime:'runtime-one',worktree:'worktree-one',status:'interrupted'});
    expect(f.executions()).toBe(1);
  });
});
