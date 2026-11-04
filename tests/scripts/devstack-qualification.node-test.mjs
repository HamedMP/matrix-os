import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { remoteProgram } from '../../scripts/devstack-qualification/remote.mjs';

const hostUrl = new URL('../../scripts/devstack-qualification/host.mjs', import.meta.url).href;

async function privateDirectory(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'devstack-initialization-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function execute(source, { env = process.env, args = [] } = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, ...args], {
    env, encoding: 'utf8', timeout: 15_000, maxBuffer: 64_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function remoteFixture(t) {
  assert.notEqual(process.getuid(), 0, 'remote initialization requires a real non-root process');
  const directory = await privateDirectory(t);
  const base = join(directory, 'existing-base');
  const tsx = join(directory, 'tools/node_modules/tsx/dist/cli.mjs');
  await mkdir(dirname(tsx), { recursive: true });
  await writeFile(tsx, '// Initialization checks the installed file; no watcher is started.\n');
  await mkdir(base);
  await writeFile(join(base, 'keep.txt'), 'preexisting owner data');
  const runId = randomUUID().replaceAll('-', '');
  return { directory, base, input: { op: 'initialize', runId, root: join(base, 'qualification-' + runId), tsx } };
}

test('failed Git initialization removes its newly allocated local fixture', async t => {
  const directory = await privateDirectory(t);
  const bin = join(directory, 'bin');
  const capture = join(directory, 'git-repository-path');
  await mkdir(bin);
  const git = join(bin, 'git');
  await writeFile(git, '#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";\nwriteFileSync(process.env.FIXTURE_CAPTURE,process.argv.at(-1));\nprocess.exit(71);\n');
  await chmod(git, 0o700);
  const result = execute(`
    import {localFixture} from ${JSON.stringify(hostUrl)};
    try { await localFixture({mutagen:process.execPath}); console.log(JSON.stringify({accepted:true})); }
    catch(error) { console.log(JSON.stringify({error:error.message})); }
  `, { env: { ...process.env, PATH: bin + ':' + process.env.PATH, FIXTURE_CAPTURE: capture } });
  assert.equal(result.error, 'git exited with 71');
  const allocated = dirname(await readFile(capture, 'utf8'));
  assert.match(allocated, /^\/tmp\/matrix-devstack-sync-[^/]+$/);
  t.after(() => rm(allocated, { recursive: true, force: true }));
  assert.equal(existsSync(allocated), false, 'failed setup left its private fixture directory behind');
});

test('remote initialization rejects a symlinked ancestor before creating a missing child', async t => {
  const { directory, base, input } = await remoteFixture(t);
  const linked = join(directory, 'linked-base');
  await symlink(base, linked);
  input.root = join(linked, 'missing-child', 'qualification-' + input.runId);
  const result = execute(remoteProgram, { args: [JSON.stringify(input)] });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'Target base must be canonical');
  assert.equal(existsSync(join(base, 'missing-child')), false, 'rejected path created a directory through the symlink');
  assert.equal(await readFile(join(base, 'keep.txt'), 'utf8'), 'preexisting owner data');
});

test('a failed owner-marker write removes only the newly created remote root', async t => {
  const { base, input } = await remoteFixture(t);
  const sibling = join(base, 'preexisting-fixture');
  await mkdir(sibling);
  await writeFile(join(sibling, 'keep.txt'), 'other fixture data');
  // Inject the filesystem failure in this subprocess, keeping the production
  // program and the remaining filesystem operations real.
  const fault = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const write=fs.writeFileSync;
    fs.writeFileSync=(file,...args)=>{
      if(file===${JSON.stringify(join(input.root, '.owner.json'))})throw Object.assign(new Error('injected marker write failure'),{code:'EIO'});
      return write(file,...args);
    };
    syncBuiltinESMExports();
  `;
  const result = execute(fault + remoteProgram, { args: [JSON.stringify(input)] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EIO');
  assert.equal(result.error.message, 'injected marker write failure');
  assert.equal(existsSync(input.root), false, 'failed marker creation left an unowned fixture root');
  assert.equal(await readFile(join(base, 'keep.txt'), 'utf8'), 'preexisting owner data');
  assert.equal(await readFile(join(sibling, 'keep.txt'), 'utf8'), 'other fixture data');
});

test('remote initialization leaves a preexisting root intact when exclusive creation fails', async t => {
  const { base, input } = await remoteFixture(t);
  await mkdir(input.root, { mode: 0o700 });
  await writeFile(join(input.root, 'keep.txt'), 'preexisting fixture data');
  const result = execute(remoteProgram, { args: [JSON.stringify(input)] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EEXIST');
  assert.equal(await readFile(join(input.root, 'keep.txt'), 'utf8'), 'preexisting fixture data');
  assert.equal(await readFile(join(base, 'keep.txt'), 'utf8'), 'preexisting owner data');
});
