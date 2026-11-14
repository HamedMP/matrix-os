import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStage3DeltaStage } from '../../scripts/devstack/stage3-delta-stage.mjs';
import { createStage3SourceSync, identifyStage3Source, identifyStage3Target } from '../../scripts/devstack/stage3-source.mjs';

const exec = promisify(execFile);
const file = (path: string, text: string, mode = 0o644) => ({ path, kind: 'file', mode, content: Buffer.from(text).toString('base64') });
const remove = (path: string) => ({ path, kind: 'delete' });
let fixture: string;
let sourceRoot: string;
let stateDir: string;
let base: string;
let sourceIdentity: string;

const git = (...args: string[]) => exec('git', ['-C', sourceRoot, ...args], { timeout: 5000 });
const factory = () => createStage3DeltaStage({ sourceRoot, sourceIdentity, base, stateDir });

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'stage3-delta-')));
  sourceRoot = join(fixture, 'source');
  stateDir = join(fixture, 'stage');
  await mkdir(sourceRoot, { mode: 0o700 });
  await git('init', '-q');
  await writeFile(join(sourceRoot, 'edit.txt'), 'baseline');
  await writeFile(join(sourceRoot, 'remove.txt'), 'restore me', { mode: 0o755 });
  await mkdir(join(sourceRoot, 'sub'));
  await writeFile(join(sourceRoot, 'sub', 'keep.txt'), 'untouched');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline');
  base = (await git('rev-parse', 'HEAD')).stdout.trim();
  sourceIdentity = await identifyStage3Source(sourceRoot);
});

afterEach(async () => rm(fixture, { force: true, recursive: true }));

describe('Stage 3 isolated delta staging', () => {
  it('feeds the same persistent clone into the receiver for A, B and exact baseline restoration', async () => {
    const root = join(fixture, 'mirror');
    await mkdir(root, { mode: 0o700 });
    const target = { root, identity: await identifyStage3Target(root), containerId: 'c'.repeat(64), handle: 'target-a' };
    const source = { root: sourceRoot, identity: sourceIdentity, computerId: 'computer-a' };
    const owner = 'user_alice';
    const selection = { runtime: 'runtime-a', worktree: 'worktree-a', generation: 'a'.repeat(64) };
    const receiver = createStage3SourceSync({
      bindings: [{ owner, ...selection, expiresAt: 2000, source, target }],
      stateDir: join(fixture, 'receiver'), now: () => 1000,
      authenticate: async () => owner,
      readBinding: async () => ({ generation: selection.generation, source: { owner, ...source }, target: { owner, ...target } }),
      testRevision: async () => ({ exitCode: 0, log: await readFile(join(root, 'edit.txt'), 'utf8') }),
    });
    const apply = (entries: ReturnType<typeof file | typeof remove>[]) => factory()({ base, entries }, () => receiver.syncAndTest('session', selection));
    const head = await apply([]);
    expect(head.test.log).toBe('baseline');
    const first = await apply([file('edit.txt', 'A'), remove('remove.txt'), file('sub/new.txt', 'A new', 0o755)]);
    expect(first.test.log).toBe('A');
    await expect(readFile(join(root, 'sub/new.txt'), 'utf8')).resolves.toBe('A new');
    await expect(lstat(join(root, 'remove.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const second = await apply([file('edit.txt', 'B'), file('new.txt', 'B new')]);
    expect(second.test.log).toBe('B');
    expect(second.test.revision).toBe(second.revision);
    await expect(lstat(join(root, 'sub/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'remove.txt'), 'utf8')).resolves.toBe('restore me');
    expect((await lstat(join(sourceRoot, 'remove.txt'))).mode & 0o777).toBe(0o755);
    const rollback = await apply([]);
    expect(rollback.revision).toBe(head.revision);
    await expect(lstat(join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await git('status', '--porcelain')).stdout).toBe('');
    expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(base);
  });

  it('rejects wrong bases, unowned edits and preflight path collisions before running the callback', async () => {
    const stage = factory();
    const action = vi.fn(async () => 'done');
    await expect(stage({ base: 'a'.repeat(40), entries: [] }, action)).rejects.toThrow(/base/i);
    await writeFile(join(sourceRoot, 'edit.txt'), 'foreign edit');
    await expect(stage({ base, entries: [file('edit.txt', 'new')] }, action)).rejects.toThrow(/diverged/i);
    await expect(readFile(join(sourceRoot, 'edit.txt'), 'utf8')).resolves.toBe('foreign edit');
    await writeFile(join(sourceRoot, 'edit.txt'), 'baseline');
    for (const invalid of ['../outside', '.git/config', 'sub', 'edit.txt/child', 'Sub/child', 'EDIT.txt']) {
      await expect(stage({ base, entries: [file('new.txt', 'never'), file(invalid, 'bad')] }, action)).rejects.toThrow();
      await expect(lstat(join(sourceRoot, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await symlink(fixture, join(sourceRoot, 'escape'));
    await expect(stage({ base, entries: [file('escape/outside', 'bad')] }, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  });

  it('withholds the callback on replaced checkouts and indexed changes', async () => {
    const stage = factory();
    const action = vi.fn(async () => 'done');
    await writeFile(join(sourceRoot, 'edit.txt'), 'foreign stage');
    await git('add', 'edit.txt');
    await expect(stage({ base, entries: [file('edit.txt', 'new')] }, action)).rejects.toThrow(/diverged/i);
    await rename(sourceRoot, sourceRoot + '-moved');
    await symlink(sourceRoot + '-moved', sourceRoot);
    await expect(stage({ base, entries: [] }, action)).rejects.toThrow(/identity/i);
    expect(action).not.toHaveBeenCalled();
  });

  it('checks the live binding before journaling or writing staged source', async () => {
    const stage = factory();
    const delta = { base, entries: [file('edit.txt', 'new'), file('new.txt', 'addition')] };
    const publish = vi.fn(async () => 'published');
    const stale = new Error('Stale DevStack binding');
    const beforeWrite = vi.fn(async () => { throw stale; });

    await expect(stage(delta, publish, { beforeWrite })).rejects.toBe(stale);
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    await expect(readFile(join(sourceRoot, 'edit.txt'), 'utf8')).resolves.toBe('baseline');
    await expect(lstat(join(sourceRoot, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(stateDir)).resolves.toEqual([]);

    await expect(stage(delta, publish, { beforeWrite: async () => {} })).resolves.toBe('published');
    await expect(readFile(join(sourceRoot, 'edit.txt'), 'utf8')).resolves.toBe('new');
  });

  it('rejects receiver index flags that can hide unexpected changes', async () => {
    const stage = factory();
    const action = vi.fn(async () => 'done');
    await git('update-index', '--assume-unchanged', 'edit.txt');
    await writeFile(join(sourceRoot, 'edit.txt'), 'hidden foreign edit');
    await expect(stage({ base, entries: [] }, action)).rejects.toThrow(/diverged/i);
    await git('update-index', '--no-assume-unchanged', '--skip-worktree', 'edit.txt');
    await expect(stage({ base, entries: [] }, action)).rejects.toThrow(/diverged/i);
    expect(action).not.toHaveBeenCalled();
  });

  it('withholds the callback when an ignored addition cannot reach the managed mirror', async () => {
    const stage = factory();
    const action = vi.fn(async () => 'done');
    await expect(stage({ base, entries: [file('.gitignore', 'ignored.txt\n'), file('ignored.txt', 'new')] }, action))
      .rejects.toThrow(/ignored source/i);
    expect(action).not.toHaveBeenCalled();
    await expect(stage({ base, entries: [] }, async () => 'clean')).resolves.toBe('clean');
    expect((await git('status', '--porcelain')).stdout).toBe('');
  });

  it('holds its source lock through callback failure and retries a completely staged delta without source writes', async () => {
    const stage = factory();
    const delta = { base, entries: [file('edit.txt', 'new')] };
    const error = new Error('callback failed');
    await expect(stage(delta, async () => {
      await expect(factory()({ base, entries: [] }, vi.fn())).rejects.toThrow(/locked/i);
      throw error;
    })).rejects.toBe(error);
    const path = join(sourceRoot, 'edit.txt');
    const { ino, mtimeNs } = await lstat(path, { bigint: true });
    await expect(factory()(delta, async () => readFile(path, 'utf8'))).resolves.toBe('new');
    await expect(lstat(path, { bigint: true })).resolves.toMatchObject({ ino, mtimeNs });
    await writeFile(path, 'foreign edit');
    await expect(stage(delta, vi.fn())).rejects.toThrow(/diverged/i);
  });

  it('requires recovery when a previous source staging operation left a pending journal', async () => {
    const stage = factory();
    const delta = { base, entries: [file('edit.txt', 'first')] };
    await stage(delta, async () => 'done');
    const [name] = await readdir(stateDir);
    const path = join(stateDir, name);
    const prior = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...prior, status: 'pending' }));
    const action = vi.fn(async () => 'done');
    await expect(stage({ base, entries: [] }, action)).rejects.toThrow(/recovery/i);
    await expect(readFile(join(sourceRoot, 'edit.txt'), 'utf8')).resolves.toBe('first');
    expect(action).not.toHaveBeenCalled();
  });
});
