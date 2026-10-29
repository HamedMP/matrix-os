import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncMain, assertMirrorMetadata } from './sync-mirror.mjs';

// Real Git transport detects rejected updates, unrelated refs and rewritten history.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'matrix-mirror-test-'));
  try {
    const source = join(root, 'source'); const destination = join(root, 'mirror.git');
    git(root, 'init', '-b', 'main', source); git(root, 'init', '--bare', destination);
    git(source, 'config', 'user.name', 'Mirror test'); git(source, 'config', 'user.email', 'mirror-test@example.invalid');
    const commit = async (value) => { await writeFile(join(source, 'fixture.txt'), value); git(source, 'add', 'fixture.txt'); git(source, 'commit', '-m', value); return git(source, 'rev-parse', 'HEAD'); };
    const first = await commit('first'); git(source, 'push', destination, 'main:main');
    await run({ source, destination, commit, first });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const safe = async () => {};
test('updates only main with the exact source commit and never copies other branches/tags', () => fixture(async ({source, destination, commit}) => {
  git(source, 'branch', 'private-work'); git(source, 'tag', 'do-not-copy');
  const latest = await commit('second'); const checks = [];
  const result = await syncMain({source, destination, assertSafe: async () => { checks.push(true); }});
  assert.equal(result.source, latest); assert.equal(result.changed, true);
  assert.equal(git(destination, 'rev-parse', 'main'), latest);
  assert.equal(git(destination, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
  assert.equal(checks.length, 3);
}));
test('unchanged state verifies guard and does not push', () => fixture(async ({source, destination, first}) => {
  const result = await syncMain({source, destination, assertSafe: safe});
  assert.deepEqual(result, {source:first, previous:first, changed:false});
}));
test('refuses a source rewrite without overwriting the mirrored history', () => fixture(async ({source, destination, first, commit}) => {
  await commit('second'); git(source, 'checkout', '--orphan', 'replacement'); await commit('unrelated'); git(source, 'branch', '-M', 'main');
  await assert.rejects(syncMain({source, destination, assertSafe:safe}), /diverged|rewritten/);
  assert.equal(git(destination, 'rev-parse', 'main'), first);
}));
test('refuses independent destination changes', () => fixture(async ({source, destination, first, commit}) => {
  const independent = await commit('mirror-only'); git(source, 'push', destination, 'main:main');
  git(source, 'reset', '--hard', first); await commit('source-only');
  await assert.rejects(syncMain({source, destination, assertSafe:safe}), /diverged|rewritten/);
  assert.equal(git(destination, 'rev-parse', 'main'), independent);
}));
test('guard failure before write leaves destination untouched', () => fixture(async ({source, destination, first, commit}) => {
  await commit('second'); let calls = 0;
  await assert.rejects(syncMain({source, destination, assertSafe:async () => { if (++calls === 2) throw Error('Actions enabled'); }}), /Actions enabled/);
  assert.equal(git(destination, 'rev-parse', 'main'), first);
}));
test('refuses a concurrently changed destination before push', () => fixture(async ({source, destination, first, commit}) => {
  const ahead = await commit('concurrent'); git(source, 'branch', 'concurrent'); git(source, 'reset', '--hard', first); await commit('source');
  let checks = 0;
  await assert.rejects(syncMain({source, destination, assertSafe:async () => { if (++checks === 2) git(source, 'push', destination, 'concurrent:main'); }}), /Mirror changed concurrently/);
  assert.equal(git(destination, 'rev-parse', 'main'), ahead);
}));
test('post-push policy failure is reported rather than hidden as success', () => fixture(async ({source, destination, commit}) => {
  const latest = await commit('second'); let checks = 0;
  await assert.rejects(syncMain({source, destination, assertSafe:async () => { if (++checks === 3) throw Error('post-write Actions enabled'); }}), /post-write/);
  assert.equal(git(destination, 'rev-parse', 'main'), latest);
}));
test('rejects unsafe or malformed repository metadata', () => {
  const metadata = {full_name:'FinnaAI/matrix-os', visibility:'public', private:false, archived:false, disabled:false, default_branch:'main'};
  assertMirrorMetadata(metadata, {enabled:false});
  for (const patch of [{private:true},{archived:true},{disabled:true},{visibility:'private'},{default_branch:'other'},{full_name:'other/repo'}]) {
    assert.throws(() => assertMirrorMetadata({...metadata,...patch}, {enabled:false}));
  }
  for (const permissions of [{enabled:true},{},null]) assert.throws(() => assertMirrorMetadata(metadata,permissions));
});
test('API authentication failure is reported without logging its response body', async () => {
  const {readGitHub} = await import('./sync-mirror.mjs');
  await assert.rejects(readGitHub('', 'fixture-not-a-secret', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/FinnaAI/matrix-os');
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.redirect, 'error');
    return {ok:false, status:401};
  }), /^Error: Mirror API check failed: HTTP 401$/);
});
