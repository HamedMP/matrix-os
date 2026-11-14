// Required Docker lane: node --test tests/scripts/devstack-isolated-runner.test.mjs
// Missing Docker/image is a failure, never a skip. No live DevStack is touched.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createIsolatedStage3TestRunner } from '../../scripts/devstack/stage3-isolated-runner.mjs';
import { createDevstackPublisherClient } from '../../packages/platform/src/devstack-publisher-client.ts';
import { identifyStage3Source, identifyStage3Target } from '../../scripts/devstack/stage3-source.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { buildStage3PreviewPlan } from '../../scripts/devstack/stage3-preview-plan.mjs';

const exec = promisify(execFile);
test('uploaded tests cannot read operational secrets, write the mirror or contact the network; revision logs and real exit codes survive', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devstack-runner-')));
  const previous = process.env.PLATFORM_SECRET;
  process.env.PLATFORM_SECRET = 'operator-canary-never-forward';
  try {
    const mirror = join(root, 'mirror');
    await mkdir(mirror, { mode: 0o700 });
    const { stdout } = await exec('docker', ['image', 'inspect', 'node:24-bookworm-slim', '--format', '{{index .RepoDigests 0}}'], { timeout: 10_000 });
    const image = stdout.trim();
    const assertion = `
      const fs = require('node:fs'), assert = require('node:assert/strict'), os = require('node:os');
      assert.equal(process.env.PLATFORM_SECRET, undefined);
      assert.equal(process.env.CLERK_SECRET_KEY, undefined);
      assert.equal(process.env.DEVSTACK_SOURCE_REVISION, '${'a'.repeat(64)}');
      assert.equal(process.getuid(), ${process.getuid()});
      assert.ok(!fs.existsSync('/var/run/docker.sock'));
      assert.ok(!fs.existsSync(${JSON.stringify(root)}));
      assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
      assert.throws(() => fs.writeFileSync('/source/value.txt', 'tampered'), { code: 'EROFS' });
      assert.throws(() => fs.writeFileSync('/root-owned', 'tampered'), { code: 'EROFS' });
      console.log('Validated ' + fs.readFileSync('value.txt', 'utf8'));
      process.exit(Number(fs.readFileSync('exit.txt', 'utf8')));
    `;
    await writeFile(join(mirror, 'test.cjs'), assertion);
    const runner = createIsolatedStage3TestRunner({ image, command: ['node', 'test.cjs'], timeoutMs: 10_000 });
    const binding = { target: { root: mirror } };
    for (const [value, code] of [['First', 0], ['Second', 7], ['Baseline', 0]]) {
      await writeFile(join(mirror, 'value.txt'), value);
      await writeFile(join(mirror, 'exit.txt'), String(code));
      const result = await runner(binding, 'a'.repeat(64), new AbortController().signal);
      assert.equal(result.exitCode, code, result.log);
      assert.match(result.log, new RegExp('Validated ' + value));
      assert.equal(await readFile(join(mirror, 'value.txt'), 'utf8'), value);
    }
    const controller = new AbortController();
    const slow = createIsolatedStage3TestRunner({ image, command: ['node', '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 10_000 });
    const pending = slow(binding, 'b'.repeat(64), controller.signal);
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(pending, { name: 'AbortError' });
    const { stdout: remaining } = await exec('docker', ['ps', '-aq', '--filter', 'label=matrix.devstack.publisher-test=true'], { timeout: 5000 });
    assert.equal(remaining.trim(), '', 'temporary runner must be removed after cancellation');
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_SECRET; else process.env.PLATFORM_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('registered preview hostname reaches its read-only mirror and sees both edits without restarting', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devstack-preview-ro-')));
  const network = 'devstack-' + randomUUID();
  const name = 'devstack-preview-' + randomUUID();
  let child;
  try {
    await writeFile(join(root, 'value.txt'), 'Baseline');
    await exec('docker', ['network', 'create', '--internal', network], { timeout: 10_000 });
    const { stdout } = await exec('docker', ['image', 'inspect', 'node:24-bookworm-slim', '--format', '{{index .RepoDigests 0}}'], { timeout: 10_000 });
    const image = stdout.trim();
    const config = { mirror: root, identity: await identifyStage3Target(root), image, name, network, handle: 'publisher-preview' };
    const args = await buildStage3PreviewPlan({ ...config,
      command: ['node', '-e', `
        const fs = require('node:fs'), assert = require('node:assert/strict');
        assert.equal(process.env.PLATFORM_SECRET, undefined);
        assert.throws(() => fs.writeFileSync('/source/value.txt', 'bad'), { code: 'EROFS' });
        const processState = 73;
        require('node:http').createServer((req, res) => res.end(processState + ' ' + fs.readFileSync('/source/value.txt', 'utf8'))).listen(3000, '0.0.0.0');
        fs.watch('/source', () => console.log(processState + ' ' + fs.readFileSync('/source/value.txt', 'utf8')));
        console.log('preview-ready');
      `] });
    await exec('docker', args, { timeout: 10_000 });
    let output = '';
    child = spawn('docker', ['start', '--attach', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output = (output + data.toString()).slice(-8192); });
    child.stderr.on('data', data => { output = (output + data.toString()).slice(-8192); });
    const observe = async expected => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (output.includes(expected)) return;
        await delay(25);
      }
      assert.fail('preview did not observe ' + expected + ': ' + output);
    };
    await observe('preview-ready');
    // RegisteredRuntimeEndpoint.host is matrixos-<handle>, independent of the
    // container's purpose-specific name. Exercise Docker DNS and HTTP itself.
    const { stdout: response } = await exec('docker', ['run', '--rm', '--network', network,
      '--read-only', '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--entrypoint=/usr/bin/env', image, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
      'node', '-e', "fetch('http://matrixos-publisher-preview:3000/', {signal:AbortSignal.timeout(3000)}).then(async r => {if(!r.ok)process.exit(1); console.log(await r.text());}).catch(error => {console.error(error.cause?.code ?? error.name); process.exit(2);})"],
    { timeout: 10_000, maxBuffer: 8192 });
    assert.equal(response.trim(), '73 Baseline');
    for (const value of ['First', 'Second', 'Baseline']) {
      await writeFile(join(root, 'value.txt'), value);
      await observe('73 ' + value);
    }
    const { stdout: inspection } = await exec('docker', ['inspect', name, '--format', '{{json .Mounts}}'], { timeout: 5000 });
    assert.ok(JSON.parse(inspection).some(mount => mount.Destination === '/source' && mount.RW === false));
    for (const handle of [undefined, 'a', 'bad.host', 'unsafe\nname']) {
      await assert.rejects(buildStage3PreviewPlan({ ...config, handle, command: ['node', '-e', 'process.exit(0)'] }), /Invalid isolated/);
    }
  } finally {
    await exec('docker', ['rm', '-f', name], { timeout: 10_000 }).catch(error => {
      if (!error.stderr?.includes('No such container')) throw error;
    });
    child?.kill('SIGKILL');
    await exec('docker', ['network', 'rm', network], { timeout: 10_000 });
    await rm(root, { recursive: true, force: true });
  }
});

test('separate publisher executable stages two deltas, runs real isolated tests, returns revision logs and restores baseline', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devstack-pub-e2e-')));
  let child;
  try {
    const staging = join(root, 'staging'), mirror = join(root, 'mirror');
    await Promise.all([mkdir(staging, { mode: 0o700 }), mkdir(mirror, { mode: 0o700 })]);
    const git = (...args) => exec('git', ['-C', staging, ...args], { timeout: 5000 });
    await git('init', '-q');
    await writeFile(join(staging, 'value.txt'), 'Baseline');
    await writeFile(join(staging, 'test.cjs'), `
      const fs = require('node:fs'), assert = require('node:assert/strict');
      assert.equal(process.env.PLATFORM_SECRET, undefined);
      assert.throws(() => fs.writeFileSync('/source/value.txt', 'bad'), { code: 'EROFS' });
      console.log(process.env.DEVSTACK_SOURCE_REVISION + ' Validated ' + fs.readFileSync('value.txt', 'utf8'));
      if (fs.readFileSync('value.txt', 'utf8') === 'Cancelled') setInterval(() => {}, 1000);
      else process.exit(fs.readFileSync('value.txt', 'utf8') === 'Second' ? 7 : 0);
    `);
    await git('add', '.');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Baseline');
    const base = (await git('rev-parse', 'HEAD')).stdout.trim();
    const binding = { owner: 'user_owner', runtime: 'runtime-one', worktree: 'worktree-one', handle: 'dev-one',
      containerId: 'a'.repeat(64), sourceIdentity: 'b'.repeat(64), clerkSessionId: 'sess_fixture' };
    const socketPath = join(root, 'publisher.sock');
    const { stdout } = await exec('docker', ['image', 'inspect', 'node:24-bookworm-slim', '--format', '{{index .RepoDigests 0}}'], { timeout: 10_000 });
    const configPath = join(root, 'publisher.json');
    await writeFile(configPath, JSON.stringify({ version: 1, socketPath, stateDir: join(root, 'state'),
      test: { image: stdout.trim(), command: ['node', 'test.cjs'], timeoutMs: 10_000 },
      enrollment: { ...binding, generation: 'c'.repeat(64), expiresAt: Date.now() + 60_000, base,
        source: { root: staging, identity: await identifyStage3Source(staging), computerId: 'fixture-main' },
        target: { root: mirror, identity: await identifyStage3Target(mirror), handle: binding.handle, containerId: binding.containerId } },
    }), { mode: 0o600 });
    let errors = '';
    child = spawn(process.execPath, ['scripts/devstack/stage3-publisher-service.mjs', configPath], {
      env: { ...process.env, PLATFORM_SECRET: 'must-not-reach-upload' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-8192); });
    const { lstat } = await import('node:fs/promises');
    let ready = false;
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
      try { ready = (await lstat(socketPath)).isSocket(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (ready) break;
      await delay(25);
    }
    assert.ok(ready, 'publisher did not start: ' + errors);
    const client = createDevstackPublisherClient({ socketPath, identity: binding.sourceIdentity });
    const send = entries => client.apply(binding, { base, entries }, async () => {});
    const baseline = await send([]);
    const receipts = [{ revision: baseline.revision, exitCode: baseline.test.exitCode }];
    for (const [value, code] of [['First', 0], ['Second', 7]]) {
      const receipt = await send([{ kind: 'file', path: 'value.txt', mode: 420, content: Buffer.from(value).toString('base64') }]);
      assert.equal(receipt.test.revision, receipt.revision);
      assert.equal(receipt.test.exitCode, code, receipt.test.log);
      assert.equal(receipt.test.log, receipt.revision + ' Validated ' + value);
      receipts.push({ revision: receipt.revision, exitCode: receipt.test.exitCode });
      assert.equal(await readFile(join(mirror, 'value.txt'), 'utf8'), value);
    }
    const restored = await send([]);
    assert.equal(restored.revision, baseline.revision);
    receipts.push({ revision: restored.revision, exitCode: restored.test.exitCode });
    assert.equal((await git('status', '--porcelain')).stdout, '');
    const controller = new AbortController();
    const pending = client.apply(binding, { base, entries: [{ kind: 'file', path: 'value.txt', mode: 420,
      content: Buffer.from('Cancelled').toString('base64') }] }, async () => {}, controller.signal)
      .then(() => 'completed', () => 'aborted');
    let testContainer;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const { stdout: ids } = await exec('docker', ['ps', '-q', '--filter', 'label=matrix.devstack.publisher-test=true'], { timeout: 5000 });
        for (const id of ids.trim().split(/\s+/).filter(Boolean)) {
          const { stdout: mounts } = await exec('docker', ['inspect', id, '--format', '{{json .Mounts}}'], { timeout: 5000 });
          if (JSON.parse(mounts).some(mount => mount.Source === mirror)) testContainer = id;
        }
        if (testContainer) break;
        await delay(25);
      }
      assert.ok(testContainer, 'our isolated test container must be running before cancellation');
    } finally { controller.abort(); }
    assert.equal(await pending, 'aborted');
    let removed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await exec('docker', ['inspect', testContainer], { timeout: 5000, maxBuffer: 64 * 1024 }); }
      catch (error) { if (!/no such object/i.test(error.stderr ?? '')) throw error; removed = true; break; }
      await delay(25);
    }
    assert.ok(removed, 'disconnect must remove only our exact test container');
    await delay(50);
    assert.equal((await send([])).revision, baseline.revision);
    assert.equal((await git('status', '--porcelain')).stdout, '');
    console.log(JSON.stringify({ lane: 'local-executable-socket-docker', receipts }));
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
    await rm(root, { recursive: true, force: true });
  }
});
