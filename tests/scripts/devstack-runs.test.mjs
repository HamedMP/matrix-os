import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const firstToken = 'first.signed.session';
const secondToken = 'second.signed.session';
const argv = ['test', 'literal;$(should-not-expand)'];
const args = ['dispatch', 'runtime-a', 'worktree-a', 'test', '--', ...argv];

function invoke(env, ...args) {
  const child = spawn('/bin/bash', ['scripts/staging-slot.sh', 'local', ...args], {
    cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
}

function reply(res, run, extra = {}, httpStatus = 200) {
  res.writeHead(httpStatus, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    runId: run.runId, runtime: run.runtime, worktree: run.worktree,
    status: 'succeeded', revision: 'b'.repeat(40), previewUrl: 'https://preview.example.test/vm/dev-a/',
    exitCode: 0, testResult: { status: 'passed', exitCode: 0 },
    logs: [], nextCursor: 0, hasMore: false, truncated: false, ...extra,
  }));
}

async function fixture(t, onRequest) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devstack-runs-')));
  const state = join(root, 'state');
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const entry = {
      method: req.method, path: req.url, body: bytes.length ? JSON.parse(bytes.toString()) : null,
      bearer: req.headers.authorization, key: req.headers['x-devstack-run-key'],
    };
    calls.push(entry);
    await onRequest(entry, res, state, calls);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    server.closeAllConnections();
    await rm(root, { recursive: true, force: true });
  });
  return { calls, state, env: {
    DEVSTACK_STATE_DIR: state, DEVSTACK_API_URL: `http://127.0.0.1:${server.address().port}`,
    DEVSTACK_CLERK_TOKEN: firstToken,
  } };
}

test('lost submit response recovers the same run and paginates its retained result with a fresh bearer', async t => {
  const f = await fixture(t, async (call, res, state, calls) => {
    const [first] = calls;
    if (calls.length === 1) {
      const record = join(state, 'runs', `${call.body.runId}.json`);
      assert.equal((await stat(record)).mode & 0o777, 0o600);
      const retained = await readFile(record, 'utf8');
      assert.match(retained, new RegExp(call.key));
      assert.doesNotMatch(retained, /first\.signed\.session/);
      res.destroy();
    } else if (call.method === 'POST') {
      reply(res, first.body, { status: 'running', exitCode: null, testResult: null }, 202);
    } else {
      const cursor = new URL(call.path, 'http://127.0.0.1').searchParams.get('cursor');
      reply(res, first.body, {
        status: 'failed', exitCode: 7, testResult: { status: 'failed', exitCode: 7 },
        logs: [{ stream: 'stderr', text: cursor === '0' ? `test failed ${call.key} ${secondToken}` : 'stack trace tail' }],
        nextCursor: cursor === '0' ? 1 : 2, hasMore: cursor === '0',
      });
    }
  });
  const submitted = await invoke(f.env, ...args);
  assert.equal(submitted.code, 1);
  assert.equal(f.calls.length, 1, submitted.stderr);
  const [{ body, key }] = f.calls;
  assert.equal(JSON.parse(submitted.stdout).runId, body.runId);
  assert.deepEqual(body.command, argv);
  assert.equal(body.runtime, 'runtime-a');
  assert.equal(body.worktree, 'worktree-a');
  assert.equal(body.kind, 'test');
  assert.match(body.runId, /^[a-f0-9-]{36}$/);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(f.calls[0].path, '/api/devstack/runs');
  assert.equal(f.calls[0].bearer, `Bearer ${firstToken}`);

  const env = { ...f.env, DEVSTACK_CLERK_TOKEN: secondToken };
  const replay = await invoke(env, 'retry', body.runId);
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).status, 'running');
  assert.deepEqual(f.calls[1].body, body);
  assert.equal(f.calls[1].bearer, `Bearer ${secondToken}`);

  const result = await invoke(env, 'result', body.runId);
  assert.equal(result.code, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.runId, body.runId);
  assert.equal(page.previewUrl, 'https://preview.example.test/vm/dev-a/');
  assert.equal(page.exitCode, 7);
  assert.deepEqual(page.testResult, { status: 'failed', exitCode: 7 });
  assert.equal(page.hasMore, true);
  assert.match(page.logs[0].text, /test failed/);
  assert.doesNotMatch(result.stdout, new RegExp(`${key}|second\\.signed\\.session`));
  const tail = await invoke(env, 'result', body.runId, String(page.nextCursor));
  assert.equal(tail.code, 0, tail.stderr);
  assert.deepEqual(JSON.parse(tail.stdout).logs, [{ stream: 'stderr', text: 'stack trace tail' }]);
  assert.equal(f.calls[2].path, `/api/devstack/runs/${body.runId}?cursor=0`);
  assert.equal(f.calls[3].path, `/api/devstack/runs/${body.runId}?cursor=1`);
  assert.ok(f.calls.every(call => call.key === key));
});

test('refuses insecure origins, redirects, foreign recovery origins and nonprivate records', async t => {
  const f = await fixture(t, (_call, res) => {
    res.writeHead(307, { location: '/different-endpoint' });
    res.end();
  });
  const invalid = await invoke({ ...f.env, DEVSTACK_API_URL: 'http://example.test' }, ...args);
  assert.equal(invalid.code, 1);
  assert.equal(f.calls.length, 0);
  const submitted = await invoke(f.env, ...args);
  assert.equal(submitted.code, 1);
  assert.equal(f.calls.length, 1, submitted.stderr);
  const { runId } = JSON.parse(submitted.stdout);
  const other = await fixture(t, () => assert.fail('Recovery credentials reached a different origin'));
  const foreign = await invoke({ ...f.env, DEVSTACK_API_URL: other.env.DEVSTACK_API_URL }, 'result', runId);
  assert.equal(foreign.code, 1);
  assert.equal(other.calls.length, 0);
  const file = join(f.state, 'runs', `${runId}.json`);
  await chmod(file, 0o644);
  const publicFile = await invoke(f.env, 'retry', runId);
  assert.equal(publicFile.code, 1);
  assert.equal(f.calls.length, 1);
});

test('rejects unbounded and mismatched results without printing raw upstream data', async t => {
  const f = await fixture(t, (call, res, _state, calls) => {
    if (calls.length === 1) {
      reply(res, call.body, { worktree: 'another-worktree', ignored: 'upstream-sensitive' }, 202);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('upstream-sensitive'.repeat(50_000));
    }
  });
  const submitted = await invoke(f.env, ...args);
  assert.equal(submitted.code, 1);
  assert.equal(f.calls.length, 1, submitted.stderr);
  const { runId } = JSON.parse(submitted.stdout);
  const result = await invoke(f.env, 'result', runId);
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(submitted.stdout + submitted.stderr + result.stdout + result.stderr, /upstream-sensitive/);
  assert.deepEqual(await readdir(join(f.state, 'runs')), [`${runId}.json`]);
});

test('an expired replay window allows result recovery but prevents command resubmission', async t => {
  const f = await fixture(t, (call, res, _state, calls) => {
    if (call.method === 'POST') res.destroy();
    else reply(res, calls[0].body);
  });
  const submitted = await invoke(f.env, ...args);
  assert.equal(submitted.code, 1);
  const { runId } = JSON.parse(submitted.stdout);
  const path = join(f.state, 'runs', `${runId}.json`);
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.createdAt = Date.now() - 360_000;
  await writeFile(path, JSON.stringify(record));
  const replay = await invoke(f.env, 'retry', runId);
  assert.equal(replay.code, 1);
  assert.equal(f.calls.length, 1);
  assert.match(replay.stderr, /retry window/);
  const result = await invoke(f.env, 'result', runId);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).runId, runId);
});
