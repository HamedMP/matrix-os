import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, readFile, realpath, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAdapter, units, shellUnit, commandRunner, redact } from '../../scripts/devstack/local.mjs';

async function fixture(t, capacity = 3) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devstack-test-')));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q', root]);
  const calls = [];
  let foreign = false, fail = false;
  const manifest = { version: 1, id: 'sample', worktree: root, machine: 'devstack-sample', preview: 'https://sample.example.test', sourceRoot: '/opt/matrix/app', managedUnits: units, sourceSHA: 'unknown', appliedRevision: 'unknown', capabilities: { sourceSync: 'unknown' } };
  const file = join(root, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest));
  const adapter = createAdapter({ registry: join(root, 'private'), capacity, runner: async (command, args) => {
    calls.push([command, args]);
    if (args.includes('/opt/matrix/.devstack-owner')) return { code: 0, stdout: JSON.stringify({ version: 1, purpose: foreign ? 'production' : 'ENG-432-local-worktree', machine: manifest.machine }), stderr: '' };
    return { code: fail ? 7 : 0, stdout: 'token=secret feedback', stderr: '' };
  } });
  return { root, adapter, file, calls, manifest, foreign: () => foreign = true, fail: () => fail = true };
}

test('register is exclusive, idempotent and capacity counts stopped claims', async t => {
  const f = await fixture(t, 1);
  await f.adapter.register(f.file);
  await f.adapter.register(f.file);
  f.manifest.id = 'another'; f.manifest.machine = 'devstack-another';
  await writeFile(f.file, JSON.stringify(f.manifest));
  await assert.rejects(f.adapter.register(f.file), /claimed|capacity/);
});
test('rejects foreign owners, invalid and symlink manifests', async t => {
  const f = await fixture(t); f.foreign();
  await assert.rejects(f.adapter.register(f.file), /owner/);
  const link = join(f.root, 'link'); await symlink(f.file, link);
  await assert.rejects(f.adapter.register(link), /symlink/);
  await writeFile(f.file, JSON.stringify({ ...f.manifest, machine: 'Main' }));
  await assert.rejects(f.adapter.register(f.file), /manifest/);
});
test('stop/resume order, preserved data and unprivileged argument execution', async t => {
  const f = await fixture(t); await f.adapter.register(f.file);
  await f.adapter.operation('sample', 'stop');
  await f.adapter.operation('sample', 'resume');
  const actions = f.calls.filter(([, args]) => args.includes('systemctl')).map(([, args]) => args.slice(-2));
  assert.deepEqual(actions, [['stop', units[1]], ['stop', units[0]], ['start', units[0]], ['start', units[1]]]);
  await f.adapter.operation('sample', 'test', ['bun', 'test', 'literal;$(value)']);
  assert.deepEqual(f.calls.at(-1)[1], ['-m', 'devstack-sample', '-u', 'matrix', '--workdir', '/opt/matrix/app', 'bun', 'test', 'literal;$(value)']);
  assert.equal((await f.adapter.status('sample')).state, 'running');
});
test('failed start retains claim and diagnostic; failing test returns exit and redacts output', async t => {
  const f = await fixture(t); await f.adapter.register(f.file); f.fail();
  const start = await f.adapter.operation('sample', 'start'); assert.equal(start.code, 7);
  assert.equal((await f.adapter.status('sample')).state, 'failed');
  const result = await f.adapter.operation('sample', 'test', ['bun', 'test']);
  assert.equal(result.code, 7); assert.match(result.stdout, /feedback/); assert.doesNotMatch(result.stdout, /secret/);
  assert.equal(JSON.parse(await readFile(join(f.root, 'private', 'sample.json'), 'utf8')).lastExitCode, 7);
});
test('each mutation rechecks owner and pinned worktree; preview/status perform no readiness', async t => {
  const f = await fixture(t); await f.adapter.register(f.file);
  const before = f.calls.length;
  assert.equal((await f.adapter.status('sample')).manifest.preview, f.manifest.preview);
  assert.equal(f.calls.length, before);
  f.foreign(); await assert.rejects(f.adapter.operation('sample', 'start'), /owner/);
  assert.equal(f.calls.filter(([, args]) => args.includes('systemctl')).length, 0);
});


test('capacity rejects distinct machines and worktrees after a stopped claim', async t => {
  const f = await fixture(t, 1); await f.adapter.register(f.file);
  await f.adapter.operation('sample', 'stop');
  const second = join(f.root, 'second'); await mkdir(second);
  execFileSync('git', ['init', '-q', second]);
  Object.assign(f.manifest, { id: 'second', machine: 'devstack-second', worktree: second });
  await writeFile(f.file, JSON.stringify(f.manifest));
  await assert.rejects(f.adapter.register(f.file), /capacity/);
});
test('all write actions reject changed owners before executing a command', async t => {
  const f = await fixture(t); await f.adapter.register(f.file); f.foreign();
  for (const action of ['start', 'stop', 'resume', 'exec', 'test', 'logs']) {
    await assert.rejects(f.adapter.operation('sample', action, ['exec', 'test'].includes(action) ? ['true'] : []), /owner/);
  }
  await assert.rejects(f.adapter.select('sample'), /owner/);
  assert.equal(f.calls.every(([, args]) => args.includes('/opt/matrix/.devstack-owner')), true);
});
test('symlink worktrees and subdirectories are rejected', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias'); await symlink(f.root, alias);
  await writeFile(f.file, JSON.stringify({ ...f.manifest, worktree: alias }));
  await assert.rejects(f.adapter.register(f.file), /Worktree/);
  const child = join(f.root, 'child'); await mkdir(child);
  await writeFile(f.file, JSON.stringify({ ...f.manifest, worktree: child }));
  await assert.rejects(f.adapter.register(f.file), /worktree/);
});
test('exclusive lock prevents concurrent register from claiming twice', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private'), { mode: 0o700 });
  await writeFile(join(f.root, 'private', '.lock'), 'existing owner', { flag: 'wx' });
  await assert.rejects(f.adapter.register(f.file), /locked/);
});
test('real process runner preserves nonzero exit and bounded feedback', () => {
  const result = commandRunner(process.execPath, ['-e', 'console.log("failed expectation"); process.exit(23)']);
  assert.equal(result.code, 23); assert.match(result.stdout, /failed expectation/);
});

test('optional fixed Shell unit starts last and stops first; arbitrary units fail', async t => {
  const f = await fixture(t); f.manifest.managedUnits = [...units, shellUnit];
  await writeFile(f.file, JSON.stringify(f.manifest)); await f.adapter.register(f.file);
  await f.adapter.operation('sample', 'start'); await f.adapter.operation('sample', 'stop');
  assert.deepEqual(f.calls.filter(([, args]) => args.includes('systemctl')).map(([, args]) => args.slice(-2)), [
    ['start', units[0]], ['start', units[1]], ['start', shellUnit],
    ['stop', shellUnit], ['stop', units[1]], ['stop', units[0]],
  ]);
  f.manifest.managedUnits.push('postgres.service'); await writeFile(f.file, JSON.stringify(f.manifest));
  await assert.rejects(f.adapter.register(f.file), /manifest/);
});
test('registry rejects a missing id', async t => {
  const f = await fixture(t);
  const missing = { ...f.manifest }; delete missing.id;
  await writeFile(f.file, JSON.stringify(missing));
  await assert.rejects(f.adapter.register(f.file), /manifest/);
});

test('replacing a Git directory at the same worktree path invalidates the claim', async t => {
  const f = await fixture(t); await f.adapter.register(f.file);
  await rename(join(f.root, '.git'), join(f.root, 'saved-git'));
  execFileSync('git', ['init', '-q', f.root]);
  await assert.rejects(f.adapter.operation('sample', 'start'), /identity/);
});

test('JSON credentials and authorization output are redacted', () => {
  const output = redact('{"api_key":"private-key","password": "private-password"} Authorization: Bearer private-bearer');
  assert.doesNotMatch(output, /private-/);
});
