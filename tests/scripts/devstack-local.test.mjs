import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, readFile, realpath, mkdir, rename, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAdapter, units, shellUnit, commandRunner, redact } from '../../scripts/devstack/local.mjs';

async function fixture(t, capacity = 3) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devstack-test-')));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q', root]);
  const calls = [];
  let foreign = false, fail = false, response = () => undefined;
  const manifest = { version: 1, id: 'sample', worktree: root, machine: 'devstack-sample', preview: 'https://sample.example.test', sourceRoot: '/opt/matrix/app', managedUnits: units, sourceSHA: 'unknown', appliedRevision: 'unknown', capabilities: { sourceSync: 'unknown' } };
  const file = join(root, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (args.includes('cat') && args.includes('/opt/matrix/.devstack-owner')) return { code: 0, stdout: JSON.stringify({ version: 1, purpose: foreign ? 'production' : 'ENG-432-local-worktree', machine: manifest.machine, id: manifest.id, worktree: manifest.worktree }), stderr: '' };
    const custom = await response(args); if (custom) return custom;
    if (args.includes('stat')) return { code: 0, stdout: '0:600:regular file' };
    if (args.includes('--property=LoadState')) return { code: 0, stdout: 'loaded', stderr: '' };
    if (args.includes('--property=ActiveState')) return { code: 0, stdout: 'inactive', stderr: '' };
    return { code: fail ? 7 : 0, stdout: 'token=secret feedback', stderr: '' };
  };
  const adapter = createAdapter({ registry: join(root, 'private'), capacity, runner });
  return { root, adapter, file, calls, manifest, runner, setResponse: fn => response = fn, foreign: () => foreign = true, fail: () => fail = true };
}

test('register is exclusive and idempotent', async t => {
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
  const actions = f.calls.filter(([, args]) => args.includes('systemctl') && (args.includes('start') || args.includes('stop'))).map(([, args]) => args.slice(-2));
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
  assert.equal(f.calls.filter(([, args]) => args.includes('systemctl') && (args.includes('start') || args.includes('stop'))).length, 0);
});


test('retained stopped claims do not prevent distinct worktree registration', async t => {
  const f = await fixture(t, 1); await f.adapter.register(f.file);
  await f.adapter.operation('sample', 'stop');
  const second = join(f.root, 'second'); await mkdir(second);
  execFileSync('git', ['init', '-q', second]);
  Object.assign(f.manifest, { id: 'second', machine: 'devstack-second', worktree: second });
  await writeFile(f.file, JSON.stringify(f.manifest));
  assert.equal((await f.adapter.register(f.file)).state, 'registered');
});
test('all write actions reject changed owners before executing a command', async t => {
  const f = await fixture(t); await f.adapter.register(f.file); f.calls.length = 0; f.foreign();
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
  assert.deepEqual(f.calls.filter(([, args]) => args.includes('systemctl') && (args.includes('start') || args.includes('stop'))).map(([, args]) => args.slice(-2)), [
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
  await assert.rejects(f.adapter.register(f.file), /identity/);
});

test('JSON credentials and authorization output are redacted', () => {
  const output = redact('{"api_key":"private-key","password": "private-password"} Authorization: Bearer private-bearer');
  assert.doesNotMatch(output, /private-/);
});


test('two registries cannot adopt a VM for a different id or worktree', async t => {
  const f = await fixture(t); await f.adapter.register(f.file);
  const other = await fixture(t);
  const manifest = { ...f.manifest, id: 'other', worktree: other.root };
  await writeFile(other.file, JSON.stringify(manifest));
  const adapter = createAdapter({ registry: join(other.root, 'private'), runner: f.runner });
  await assert.rejects(adapter.register(other.file), /owner/);
  manifest.id = f.manifest.id; await writeFile(other.file, JSON.stringify(manifest));
  await assert.rejects(adapter.register(other.file), /owner/);
});
test('later start failure rolls back newly started units, preserves healthy units and logs evidence', async t => {
  const f = await fixture(t); f.manifest.managedUnits = [...units, shellUnit];
  await writeFile(f.file, JSON.stringify(f.manifest)); await f.adapter.register(f.file);
  f.setResponse(args => {
    if (args.includes('--property=ActiveState')) return { code: 0, stdout: args.at(-1) === units[0] ? 'active' : 'inactive' };
    if (args.includes('start') && args.at(-1) === shellUnit) return { code: 9, stderr: 'Shell failed' };
  });
  assert.equal((await f.adapter.operation('sample', 'start')).code, 9);
  const mutations = f.calls.filter(([, args]) => args.includes('start') || args.includes('stop')).map(([, args]) => args.slice(-2));
  assert.deepEqual(mutations, [['start', units[1]], ['start', shellUnit], ['stop', shellUnit], ['stop', units[1]]]);
  const before = await f.adapter.status('sample');
  await f.adapter.operation('sample', 'logs');
  const after = await f.adapter.status('sample');
  assert.deepEqual(after.diagnostic, before.diagnostic);
  assert.equal(after.diagnostic.unit, shellUnit); assert.equal(after.lastExitCode, 9);
});
test('large Unicode and escape-heavy diagnostics remain readable after failure and do not block peers', async t => {
  for (const text of ['界'.repeat(32768), '\u0000'.repeat(32768)]) {
    const f = await fixture(t); await f.adapter.register(f.file);
    f.setResponse(args => args.includes('--workdir') ? { code: 8, stderr: text } : undefined);
    await f.adapter.operation('sample', 'test', ['false']);
    const path = join(f.root, 'private', 'sample.json');
    assert.ok((await stat(path)).size <= 65536);
    await f.adapter.status('sample'); await f.adapter.operation('sample', 'stop');
    const second = await fixture(t);
    second.manifest.id = 'second'; second.manifest.machine = 'devstack-second';
    await writeFile(second.file, JSON.stringify(second.manifest));
    const adapter = createAdapter({ registry: join(f.root, 'private'), runner: second.runner });
    await adapter.register(second.file);
  }
});
test('read-only preflight checks unit prerequisites and consumes no claim', async t => {
  const f = await fixture(t);
  const preflight = await f.adapter.preflight(f.file);
  assert.equal(preflight.prerequisites, 'verified');
  assert.equal(preflight.readiness, 'unknown');
  await assert.rejects(stat(join(f.root, 'private')), /ENOENT/);
  f.setResponse(args => args.includes('--property=LoadState') ? { code: 0, stdout: 'not-found' } : undefined);
  await assert.rejects(f.adapter.register(f.file), /unit/);
  assert.equal(f.calls.some(([, args]) => args.includes('start')), false);
});
test('operator manifest must be absolute canonical owned private 0600', async t => {
  const f = await fixture(t);
  await chmod(f.file, 0o666); await assert.rejects(f.adapter.register(f.file), /0600|private/);
  await chmod(f.file, 0o600);
  const relative = await import('node:path').then(({ relative }) => relative(process.cwd(), f.file));
  await assert.rejects(f.adapter.register(relative), /absolute/);
});
test('a delayed command locks only its instance while peers and switch remain independent', async t => {
  const a = await fixture(t), b = await fixture(t);
  b.manifest.id = 'peer'; b.manifest.machine = 'devstack-peer'; await writeFile(b.file, JSON.stringify(b.manifest));
  const adapter = createAdapter({ registry: join(a.root, 'private'), runner: (cmd, args) => args[1] === a.manifest.machine ? a.runner(cmd, args) : b.runner(cmd, args) });
  await adapter.register(a.file); await adapter.register(b.file);
  let release, entered;
  const started = new Promise(resolve => entered = resolve);
  a.setResponse(args => args.includes('--workdir') ? new Promise(resolve => { release = () => resolve({ code: 0, stdout: 'done' }); entered(); }) : undefined);
  const pending = adapter.operation('sample', 'test', ['wait']); await started;
  try {
    await adapter.operation('peer', 'logs'); await adapter.operation('peer', 'stop'); await adapter.select('peer');
    await assert.rejects(adapter.operation('sample', 'logs'), /locked/);
  } finally { release(); await pending; }
});
test('logs are observational and retain failed lifecycle exit and diagnostic', async t => {
  const f = await fixture(t); await f.adapter.register(f.file); f.fail();
  await f.adapter.operation('sample', 'start');
  const before = await f.adapter.status('sample');
  f.setResponse(args => args.includes('journalctl') ? { code: 0, stdout: 'journal entry' } : undefined);
  await f.adapter.operation('sample', 'logs');
  const after = await f.adapter.status('sample');
  assert.deepEqual(after.diagnostic, before.diagnostic); assert.equal(after.lastExitCode, before.lastExitCode);
});

test('preflight rejects a guest marker writable by non-root owners', async t => {
  const f = await fixture(t);
  f.setResponse(args => args.includes('stat') ? { code: 0, stdout: '501:666:regular file' } : undefined);
  await assert.rejects(f.adapter.preflight(f.file), /protected|marker/);
});
test('later Gateway failure rolls back all attempted inactive units and records rollback errors', async t => {
  const f = await fixture(t); await f.adapter.register(f.file);
  f.setResponse(args => {
    if (args.includes('start') && args.at(-1) === units[1]) return { code: 12, stderr: 'Gateway failed' };
    if (args.includes('stop') && args.at(-1) === units[0]) return { code: 13, stderr: 'rollback failed' };
  });
  const outcome = await f.adapter.operation('sample', 'resume'); assert.equal(outcome.code, 12);
  assert.deepEqual(f.calls.filter(([, args]) => args.includes('start') || args.includes('stop')).map(([, args]) => args.slice(-2)), [
    ['start', units[0]], ['start', units[1]], ['stop', units[1]], ['stop', units[0]],
  ]);
  const record = await f.adapter.status('sample');
  assert.equal(record.state, 'failed'); assert.equal(record.diagnostic.unit, units[1]);
  assert.deepEqual(record.diagnostic.rollback, [{ unit: units[1], code: 0 }, { unit: units[0], code: 13 }]);
});
test('oversized manifest is rejected before remote calls and command feedback preserves lifecycle failure', async t => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ ...f.manifest, preview: `https://example.test/${'界'.repeat(16384)}` }));
  await assert.rejects(f.adapter.preflight(f.file), /bounded|budget/); assert.equal(f.calls.length, 0);
  await writeFile(f.file, JSON.stringify(f.manifest)); await f.adapter.register(f.file); f.fail();
  await f.adapter.operation('sample', 'start'); const before = await f.adapter.status('sample');
  f.setResponse(args => args.includes('--workdir') ? { code: 0, stdout: 'test passed' } : undefined);
  await f.adapter.operation('sample', 'test', ['true']); const after = await f.adapter.status('sample');
  assert.deepEqual(after.diagnostic, before.diagnostic); assert.equal(after.lastExitCode, 7);
  assert.equal(after.lastCommand.code, 0);
});

async function redactedOwnershipFixture(t) {
  const f = await fixture(t);
  const worktree = join(f.root, 'sk-fixture'), alias = join(f.root, '[redacted]');
  for (const directory of [worktree, alias]) {
    await mkdir(directory); execFileSync('git', ['init', '-q', directory]);
  }
  f.manifest.worktree = worktree;
  await writeFile(f.file, JSON.stringify(f.manifest));
  return { ...f, alias };
}
test('matching owner worktree containing a token-like name validates original bytes', async t => {
  const f = await redactedOwnershipFixture(t);
  assert.equal((await f.adapter.preflight(f.file)).prerequisites, 'verified');
});
test('a literal redacted-alias worktree cannot match a different original owner path', async t => {
  const f = await redactedOwnershipFixture(t);
  await writeFile(f.file, JSON.stringify({ ...f.manifest, worktree: f.alias }));
  await assert.rejects(f.adapter.preflight(f.file), /owner/);
});
test('relative registry override rejects at construction before any filesystem writes', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'relative-state');
  const relative = await import('node:path').then(module => module.relative(process.cwd(), path));
  assert.throws(() => createAdapter({ registry: relative, runner: f.runner }), /absolute/);
  await assert.rejects(stat(path), /ENOENT/);
});
test('writerless FIFO manifest rejects in a bounded subprocess instead of hanging', async t => {
  const f = await fixture(t); const fifo = join(f.root, 'manifest.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const moduleURL = new URL('../../scripts/devstack/local.mjs', import.meta.url).href;
  const program = `import { createAdapter } from ${JSON.stringify(moduleURL)};
    try { await createAdapter().preflight(process.argv[1]); process.exitCode = 8; }
    catch (error) { console.log(error.message); process.exitCode = /regular|0600/.test(error.message) ? 0 : 9; }`;
  const result = await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, ['--input-type=module', '-e', program, fifo], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' }));
  assert.equal(result.error, undefined, 'FIFO input must reject without waiting for a writer');
  assert.equal(result.status, 0); assert.match(result.stdout, /regular|0600/);
});


async function capacityGroup(t, capacity, count = 3) {
  const members = [];
  for (let index = 0; index < count; index++) {
    const f = await fixture(t); f.manifest.id = `member-${index}`; f.manifest.machine = `devstack-member-${index}`;
    await writeFile(f.file, JSON.stringify(f.manifest)); members.push(f);
  }
  const adapter = createAdapter({ registry: join(members[0].root, 'private'), capacity,
    runner: (command, args) => members.find(f => f.manifest.machine === args[1]).runner(command, args) });
  for (const f of members) await adapter.register(f.file);
  return { adapter, members, id: index => members[index].manifest.id };
}
test('active C=2 admits three retained owners and releases a slot only after successful stop', async t => {
  const { adapter, members, id } = await capacityGroup(t, 2);
  await adapter.operation(id(0), 'start'); await adapter.operation(id(1), 'start');
  await adapter.operation(id(0), 'start'); // Existing active instance needs no extra lease.
  const bBefore = await adapter.status(id(1));
  await assert.rejects(adapter.operation(id(2), 'start'), /capacity/);
  assert.equal(members[2].calls.some(([, args]) => args.includes('start')), false);
  await adapter.operation(id(0), 'stop'); await adapter.operation(id(2), 'resume');
  assert.deepEqual(await adapter.status(id(1)), bBefore);
  assert.equal((await adapter.status(id(0))).activeLease, false);
  assert.equal((await adapter.status(id(2))).activeLease, true);
});
test('concurrent starts serialize short admission while starting peers leave logs/test usable', async t => {
  const { adapter, members, id } = await capacityGroup(t, 2);
  let release, entered;
  const started = new Promise(resolve => entered = resolve);
  members[0].setResponse(args => args.includes('start') && args.at(-1) === units[0] ? new Promise(resolve => {
    release = () => resolve({ code: 0 }); entered();
  }) : undefined);
  const first = adapter.operation(id(0), 'start'); await started;
  try {
    const [second] = await Promise.all([adapter.operation(id(1), 'start'), adapter.operation(id(2), 'logs')]);
    assert.equal(second.code, 0);
    await adapter.operation(id(2), 'test', ['true']);
    await assert.rejects(adapter.operation(id(2), 'start'), /capacity/);
    assert.equal((await adapter.status(id(0))).state, 'starting');
  } finally { release(); await first; }
});
test('simultaneous independent starts both get available active slots', async t => {
  const { adapter, id } = await capacityGroup(t, 2, 2);
  const results = await Promise.all([adapter.operation(id(0), 'start'), adapter.operation(id(1), 'start')]);
  assert.equal(results.every(result => result.code === 0), true);
});
test('failed start keeps capacity for preexisting units or rollback failures, releases fully stopped rollback', async t => {
  for (const mode of ['preexisting', 'rollback-failed', 'clean-rollback']) {
    const { adapter, members, id } = await capacityGroup(t, 1, 2);
    members[0].setResponse(args => {
      if (mode === 'preexisting' && args.includes('--property=ActiveState') && args.at(-1) === units[0]) return { code: 0, stdout: 'active' };
      if (args.includes('start') && args.at(-1) === units[1]) return { code: 7 };
      if (mode === 'rollback-failed' && args.includes('stop')) return { code: 9 };
    });
    await adapter.operation(id(0), 'start');
    assert.equal((await adapter.status(id(0))).activeLease, mode !== 'clean-rollback');
    if (mode === 'clean-rollback') assert.equal((await adapter.operation(id(1), 'start')).code, 0);
    else {
      await assert.rejects(adapter.operation(id(1), 'start'), /capacity/);
      members[0].setResponse(() => undefined);
      await adapter.operation(id(0), 'stop');
      assert.equal((await adapter.operation(id(1), 'start')).code, 0);
    }
  }
});
test('legacy running records without lease fields retain capacity until explicit successful stop', async t => {
  const { adapter, members, id } = await capacityGroup(t, 1, 2);
  const path = join(members[0].root, 'private', `${id(0)}.json`);
  const record = JSON.parse(await readFile(path, 'utf8')); record.state = 'running'; delete record.activeLease;
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(adapter.operation(id(1), 'start'), /capacity/);
  await adapter.operation(id(0), 'stop');
  assert.equal((await adapter.operation(id(1), 'start')).code, 0);
});
test('stopped retained claims do not require their finished Git worktree during peer admission', async t => {
  const { adapter, members, id } = await capacityGroup(t, 1, 2);
  await adapter.operation(id(0), 'start'); await adapter.operation(id(0), 'stop');
  await rename(join(members[0].root, '.git'), join(members[0].root, 'finished-git'));
  assert.equal((await adapter.operation(id(1), 'start')).code, 0);
});
test('failed stop and unknown initial activity retain a conservative active lease', async t => {
  const { adapter, members, id } = await capacityGroup(t, 1, 2);
  await adapter.operation(id(0), 'start');
  members[0].setResponse(args => args.includes('stop') ? { code: 8 } : undefined);
  assert.equal((await adapter.operation(id(0), 'stop')).code, 8);
  assert.equal((await adapter.status(id(0))).activeLease, true);
  await assert.rejects(adapter.operation(id(1), 'start'), /capacity/);
  members[0].setResponse(args => args.includes('--property=ActiveState') ? { code: 0, stdout: 'activating' } : undefined);
  await adapter.operation(id(0), 'resume');
  assert.equal((await adapter.status(id(0))).activeLease, true);
  await assert.rejects(adapter.operation(id(1), 'start'), /capacity/);
});

test('new adoption requires stopped fixed units; existing running registration stays idempotent', async t => {
  for (const state of ['active', 'activating', 'deactivating', 'reloading', 'unknown']) {
    const f = await fixture(t, 1);
    f.setResponse(args => args.includes('--property=ActiveState') && args.at(-1) === units[1] ? { code: 0, stdout: state } : undefined);
    await assert.rejects(f.adapter.register(f.file), /stopped|inactive|adopt/);
    await assert.rejects(stat(join(f.root, 'private', 'sample.json')), /ENOENT/);
    if (state === 'active') {
      const peer = await fixture(t); peer.manifest.id = 'peer'; peer.manifest.machine = 'devstack-peer';
      await writeFile(peer.file, JSON.stringify(peer.manifest));
      const adapter = createAdapter({ registry: join(f.root, 'private'), capacity: 1,
        runner: (command, args) => args[1] === peer.manifest.machine ? peer.runner(command, args) : f.runner(command, args) });
      await adapter.register(peer.file); assert.equal((await adapter.operation('peer', 'start')).code, 0);
      assert.equal(f.calls.some(([, args]) => args.includes('start')), false);
    }
  }
  const f = await fixture(t, 1); await f.adapter.register(f.file); await f.adapter.operation('sample', 'start');
  f.setResponse(args => args.includes('--property=ActiveState') ? { code: 0, stdout: 'active' } : undefined);
  assert.equal((await f.adapter.register(f.file)).state, 'running');
});
test('failed stop of an unleased claim cannot manufacture admission permission', async t => {
  const { adapter, members, id } = await capacityGroup(t, 1, 2);
  await adapter.operation(id(0), 'start');
  members[1].setResponse(args => args.includes('stop') ? { code: 9 } : undefined);
  assert.equal((await adapter.operation(id(1), 'stop')).code, 9);
  assert.equal((await adapter.status(id(1))).activeLease, false);
  await assert.rejects(adapter.operation(id(1), 'resume'), /capacity/);
  assert.equal(members[1].calls.some(([, args]) => args.includes('start')), false);
  await adapter.operation(id(0), 'stop');
  assert.equal((await adapter.operation(id(1), 'resume')).code, 0);
});
