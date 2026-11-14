import { execFile, execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStage3SourceSync, identifyStage3Source, identifyStage3Target } from '../../scripts/devstack/stage3-source.mjs';

const hex = (char: string) => char.repeat(64);
let fixture: string;
let stateDir: string;
let now: number;

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

async function prepare(name: string, nonce: string) {
  const source = join(fixture, 'source-' + name);
  const target = join(fixture, 'target-' + name);
  await mkdir(source);
  await mkdir(target, { mode: 0o700 });
  git(source, 'init', '-q');
  await writeFile(join(source, 'edit.txt'), name);
  await writeFile(join(source, 'delete.txt'), 'delete me');
  git(source, 'add', '.');
  return {
    owner: 'user_' + name,
    runtime: 'runtime-' + name,
    worktree: 'worktree-' + name,
    generation: hex(nonce),
    expiresAt: 10_000,
    source: { computerId: 'computer-' + name, root: source, identity: await identifyStage3Source(source) },
    target: { handle: 'target-' + name, containerId: hex(nonce), root: target, identity: await identifyStage3Target(target) },
  };
}

type Binding = Awaited<ReturnType<typeof prepare>>;

function selection(binding: Binding) {
  return { runtime: binding.runtime, worktree: binding.worktree, generation: binding.generation };
}

function evidence(binding: Binding) {
  return {
    generation: binding.generation,
    source: { owner: binding.owner, computerId: binding.source.computerId, identity: binding.source.identity },
    target: { owner: binding.owner, handle: binding.target.handle, containerId: binding.target.containerId, identity: binding.target.identity },
  };
}

function receiver(bindings: Binding[], readBinding = async (binding: Binding) => evidence(binding)) {
  return createStage3SourceSync({
    stateDir, bindings, now: () => now,
    authenticate: async (session: unknown) => {
      if (session === 'alice-session') return 'user_alice';
      if (session === 'bob-session') return 'user_bob';
      return null;
    },
    readBinding,
  });
}

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'stage3-source-')));
  stateDir = join(fixture, 'state');
  now = 1000;
});

afterEach(async () => rm(fixture, { recursive: true, force: true }));

describe('Stage 3 registered source synchronization', () => {
  it('projects uncommitted additions, edits, and deletes with a stable revision on reconnect', async () => {
    const alice = await prepare('alice', 'a');
    const source = alice.source.root;
    const target = alice.target.root;
    const first = await receiver([alice]).sync('alice-session', selection(alice));
    expect(first).toMatchObject({ files: 2, updated: 2, removed: 0, revision: /^[a-f0-9]{64}$/ });
    await writeFile(join(source, 'edit.txt'), 'unstaged edit');
    await writeFile(join(source, 'new.txt'), 'untracked source');
    await writeFile(join(source, '.env'), 'private');
    await rm(join(source, 'delete.txt'));
    const gitBefore = git(source, 'status', '--porcelain=v1', '-z');

    const second = await receiver([alice]).sync('alice-session', selection(alice));
    expect(second).toMatchObject({ files: 2, updated: 2, removed: 1 });
    expect(second.revision).not.toBe(first.revision);
    await expect(readFile(join(target, 'edit.txt'), 'utf8')).resolves.toBe('unstaged edit');
    await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('untracked source');
    for (const path of ['delete.txt', '.env', '.git']) {
      await expect(lstat(join(target, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(git(source, 'status', '--porcelain=v1', '-z')).toBe(gitBefore);
    await expect(receiver([alice]).sync('alice-session', selection(alice))).resolves.toMatchObject({
      updated: 0, removed: 0, revision: second.revision,
    });
  });

  it('allows two isolated owners to sync concurrently and denies a cross-owner request', async () => {
    const [alice, bob] = await Promise.all([prepare('alice', 'a'), prepare('bob', 'b')]);
    const sync = receiver([alice, bob]);
    await Promise.all([sync.sync('alice-session', selection(alice)), sync.sync('bob-session', selection(bob))]);
    await expect(sync.sync('alice-session', selection(bob))).rejects.toThrow(/binding unavailable/i);
    await expect(sync.sync('invalid-session', selection(alice))).rejects.toThrow(/binding unavailable/i);
    await expect(readFile(join(alice.target.root, 'edit.txt'), 'utf8')).resolves.toBe('alice');
    await expect(readFile(join(bob.target.root, 'edit.txt'), 'utf8')).resolves.toBe('bob');
  });

  it('denies stale selections, expired bindings and changed source or runtime attestations', async () => {
    const alice = await prepare('alice', 'a');
    const valid = evidence(alice);
    const bad = [
      { ...valid, generation: hex('b') },
      { ...valid, source: { ...valid.source, owner: 'user_bob' } },
      { ...valid, source: { ...valid.source, computerId: 'other-source' } },
      { ...valid, source: { ...valid.source, identity: hex('b') } },
      { ...valid, target: { ...valid.target, owner: 'user_bob' } },
      { ...valid, target: { ...valid.target, containerId: hex('b') } },
      { ...valid, target: { ...valid.target, handle: 'other-target' } },
      { ...valid, target: { ...valid.target, identity: hex('b') } },
    ];
    for (const observed of bad) {
      await expect(receiver([alice], async () => observed).sync('alice-session', selection(alice)))
        .rejects.toThrow(/binding unavailable/i);
    }
    await expect(receiver([alice]).sync('alice-session', { ...selection(alice), generation: hex('b') }))
      .rejects.toThrow(/binding unavailable/i);
    now = alice.expiresAt;
    await expect(receiver([alice]).sync('alice-session', selection(alice))).rejects.toThrow(/binding unavailable/i);
    await expect(lstat(join(alice.target.root, 'edit.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks the binding and authentication immediately before publishing', async () => {
    const alice = await prepare('alice', 'a');
    let checks = 0;
    const sync = receiver([alice], async binding => {
      checks += 1;
      return { ...evidence(binding), generation: checks === 1 ? alice.generation : hex('b') };
    });
    await expect(sync.sync('alice-session', selection(alice))).rejects.toThrow(/binding unavailable/i);
    expect(checks).toBe(2);
    await expect(lstat(join(alice.target.root, 'edit.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    let authChecks = 0;
    const revoked = createStage3SourceSync({
      bindings: [alice], stateDir, now: () => now,
      authenticate: async () => ++authChecks === 1 ? alice.owner : null,
      readBinding: async () => evidence(alice),
    });
    await expect(revoked.sync('alice-session', selection(alice))).rejects.toThrow(/binding unavailable/i);
    expect(authChecks).toBe(2);
    await expect(lstat(join(alice.target.root, 'edit.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects replaced source and target directories and overlapping enrollments', async () => {
    const [alice, bob] = await Promise.all([prepare('alice', 'a'), prepare('bob', 'b')]);
    expect(() => receiver([alice, { ...bob, target: { ...bob.target, root: alice.target.root } }]))
      .toThrow(/overlap/i);
    await rename(alice.source.root, alice.source.root + '-old');
    await mkdir(alice.source.root);
    git(alice.source.root, 'init', '-q');
    await expect(receiver([alice]).sync('alice-session', selection(alice))).rejects.toThrow(/binding unavailable/i);
    await rename(bob.target.root, bob.target.root + '-old');
    await symlink(alice.target.root, bob.target.root);
    await expect(receiver([bob]).sync('bob-session', selection(bob))).rejects.toThrow(/binding unavailable/i);
  });

  it('does not overwrite or delete an externally modified managed target path', async () => {
    const alice = await prepare('alice', 'a');
    const sync = receiver([alice]);
    await sync.sync('alice-session', selection(alice));
    await writeFile(join(alice.target.root, 'delete.txt'), 'unexpected target bytes');
    await rm(join(alice.source.root, 'delete.txt'));
    await writeFile(join(alice.source.root, 'edit.txt'), 'pending edit');
    await expect(sync.sync('alice-session', selection(alice))).rejects.toThrow(/target diverged/i);
    await expect(readFile(join(alice.target.root, 'delete.txt'), 'utf8')).resolves.toBe('unexpected target bytes');
    await expect(readFile(join(alice.target.root, 'edit.txt'), 'utf8')).resolves.toBe('alice');
  });

  it('preserves the projection when an unmanaged child blocks a directory replacement', async () => {
    const alice = await prepare('alice', 'a');
    const sourcePath = join(alice.source.root, 'replace');
    const targetPath = join(alice.target.root, 'replace');
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, 'managed.txt'), 'managed');
    const sync = receiver([alice]);
    await sync.sync('alice-session', selection(alice));
    await writeFile(join(targetPath, 'external.txt'), 'unmanaged');
    await rm(sourcePath, { recursive: true });
    await writeFile(sourcePath, 'replacement');

    await expect(sync.sync('alice-session', selection(alice))).rejects.toThrow(/unmanaged path/i);
    await expect(readFile(join(targetPath, 'managed.txt'), 'utf8')).resolves.toBe('managed');
    await expect(readFile(join(targetPath, 'external.txt'), 'utf8')).resolves.toBe('unmanaged');
    await rm(join(targetPath, 'external.txt'));
    await expect(sync.sync('alice-session', selection(alice))).resolves.toMatchObject({ updated: 1, removed: 1 });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('replacement');
  });

  it('publishes a staged snapshot and reconciles a source edit made during final attestation', async () => {
    const alice = await prepare('alice', 'a');
    await receiver([alice]).sync('alice-session', selection(alice));
    const sourceFile = join(alice.source.root, 'edit.txt');
    const targetFile = join(alice.target.root, 'edit.txt');
    await writeFile(sourceFile, 'first edit');
    await rm(join(alice.source.root, 'delete.txt'));
    let checks = 0;
    const sync = receiver([alice], async binding => {
      if (++checks === 2) await writeFile(sourceFile, 'later edit');
      return evidence(binding);
    });

    await expect(sync.sync('alice-session', selection(alice))).resolves.toMatchObject({ updated: 1, removed: 1 });
    await expect(readFile(targetFile, 'utf8')).resolves.toBe('first edit');
    await expect(lstat(join(alice.target.root, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(sync.sync('alice-session', selection(alice))).resolves.toMatchObject({ updated: 1, removed: 0 });
    await expect(readFile(targetFile, 'utf8')).resolves.toBe('later edit');
  });

  it('can resume after a disconnected client loses its receipt after a completed sync', async () => {
    const alice = await prepare('alice', 'a');
    const sync = receiver([alice]);
    const disconnect = new Error('client stream disconnected');
    const watching = createStage3SourceSync({
      bindings: [alice], stateDir, now: () => now,
      authenticate: async () => alice.owner, readBinding: async () => evidence(alice),
      testRevision: async () => ({ exitCode: 1, log: 'expected fixture failure' }),
    });
    const seen = [];
    await expect(watching.watch('alice-session', selection(alice), {
      signal: new AbortController().signal,
      emit: event => { seen.push(event); if (event.type === 'test') throw disconnect; },
    })).rejects.toBe(disconnect);
    const [, update, test] = seen;
    expect(test).toMatchObject({ type: 'test', revision: update.revision, exitCode: 1 });
    await expect(sync.sync('alice-session', selection(alice))).resolves.toMatchObject({
      revision: update.revision, updated: 0, removed: 0,
    });
  });

  it('returns the test result of the published revision and replays unchanged source without writes', async () => {
    const alice = await prepare('alice', 'a');
    const targetFile = join(alice.target.root, 'edit.txt');
    const sourceFile = join(alice.source.root, 'edit.txt');
    const tested: string[] = [];
    const sync = createStage3SourceSync({
      bindings: [alice], stateDir, now: () => now,
      authenticate: async () => alice.owner, readBinding: async () => evidence(alice),
      testRevision: async (_binding, revision) => {
        tested.push(revision);
        return { exitCode: 3, log: 'fixture failure\n' + await readFile(targetFile, 'utf8') };
      },
    });

    const first = await sync.syncAndTest('alice-session', selection(alice));
    expect(first).toMatchObject({ updated: 2, removed: 0, test: { revision: first.revision, exitCode: 3, log: 'fixture failure alice' } });
    const { ino, mtimeNs } = await lstat(targetFile, { bigint: true });
    const replay = await sync.syncAndTest('alice-session', selection(alice));
    expect(replay).toMatchObject({ revision: first.revision, updated: 0, removed: 0, test: first.test });
    await expect(lstat(targetFile, { bigint: true })).resolves.toMatchObject({ ino, mtimeNs });

    await writeFile(sourceFile, 'new edit');
    const next = await sync.syncAndTest('alice-session', selection(alice));
    expect(next.revision).not.toBe(first.revision);
    expect(next).toMatchObject({ updated: 1, removed: 0, test: { revision: next.revision, exitCode: 3, log: 'fixture failure new edit' } });
    expect(tested).toEqual([first.revision, first.revision, next.revision]);
  });

  it('holds the one-shot target lock through testing and withholds results when the binding expires', async () => {
    const alice = await prepare('alice', 'a');
    const testing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const oneShot = createStage3SourceSync({
      bindings: [alice], stateDir, now: () => now,
      authenticate: async () => alice.owner, readBinding: async () => evidence(alice),
      testRevision: async () => {
        testing.resolve();
        await release.promise;
        return { exitCode: 0, log: 'fixture pass' };
      },
    });

    const running = oneShot.syncAndTest('alice-session', selection(alice));
    const rejected = expect(running).rejects.toThrow(/binding unavailable/i);
    try {
      await testing.promise;
      await expect(receiver([alice]).sync('alice-session', selection(alice))).rejects.toThrow(/registry locked/i);
      now = alice.expiresAt;
    } finally {
      release.resolve();
      await rejected;
    }
  });

  it('serializes simultaneous publishers to the same target even across receiver instances', async () => {
    const alice = await prepare('alice', 'a');
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = receiver([alice], async binding => {
      locked.resolve();
      await release.promise;
      return evidence(binding);
    });
    const inFlight = first.sync('alice-session', selection(alice));
    try {
      await locked.promise;
      await expect(receiver([alice]).sync('alice-session', selection(alice))).rejects.toThrow(/registry locked/i);
    } finally {
      release.resolve();
      await inFlight;
    }
    await expect(receiver([alice]).sync('alice-session', selection(alice))).resolves.toMatchObject({ updated: 0 });
  });

  it('feeds the packaged Matrix CLI revision-correlated test receipts through its enrolled adapter', async () => {
    const alice = await prepare('alice', 'a');
    const home = join(fixture, 'client');
    const profile = join(home, '.matrixos');
    await mkdir(profile, { mode: 0o700, recursive: true });
    const adapterUrl = new URL('../../scripts/devstack/stage3-source.mjs', import.meta.url).href;
    await writeFile(join(profile, 'devstack-stage3-adapter'), `#!${process.execPath}
import { createStage3SourceSync } from ${JSON.stringify(adapterUrl)};
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const binding = ${JSON.stringify(alice)};
const active = ${JSON.stringify(evidence(alice))};
const [action, runtime, worktree] = process.argv.slice(2);
if (action !== 'watch') process.exit(64);
const stop = new AbortController();
let tested = 0;
const receiver = createStage3SourceSync({
  stateDir: ${JSON.stringify(stateDir)}, bindings: [binding], now: () => 1000,
  authenticate: async () => binding.owner, readBinding: async () => active,
  testRevision: async (binding) => {
    const text = await readFile(join(binding.target.root, 'edit.txt'), 'utf8');
    if (tested++ === 0) await writeFile(join(binding.source.root, 'edit.txt'), 'recovered edit');
    else stop.abort();
    return { exitCode: 0, log: 'Verified source: ' + text };
  },
});
await receiver.watch(null, { runtime, worktree, generation: binding.generation }, {
  signal: stop.signal, emit: receipt => console.log(JSON.stringify(receipt)),
});
`, { mode: 0o700 });

    const cli = new URL('../../packages/sync-client/bin/matrix.mjs', import.meta.url);
    const { stdout } = await promisify(execFile)(process.execPath, [
      cli.pathname, 'devstack', 'watch', '--stage', '3', '--computer', alice.runtime, '--worktree', alice.worktree, '--json',
    ], { env: { ...process.env, HOME: home, USERPROFILE: home, MATRIX_NO_TELEMETRY: '1' }, timeout: 15_000 });
    const events = stdout.trim().split('\n').map(line => JSON.parse(line).data);
    expect(events.map(event => event.type)).toEqual(['ready', 'update', 'test', 'update', 'test', 'stopped']);
    expect(events[2]).toMatchObject({ revision: events[1].revision, exitCode: 0, log: 'Verified source: alice' });
    expect(events[4]).toMatchObject({ revision: events[3].revision, exitCode: 0, log: 'Verified source: recovered edit' });
    expect(events[3].revision).not.toBe(events[1].revision);
  }, 20_000);
});
