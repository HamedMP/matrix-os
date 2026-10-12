import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/build-typescript.mjs');
const directories: string[] = [];
const children: ChildProcess[] = [];
const compilerPids: number[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const pid of compilerPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function waitFor(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error('Lifecycle condition did not settle');
    await new Promise(accept => setTimeout(accept, 20));
  }
}
async function exists(path: string) {
  try { await readFile(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(accept => child.once('close', (code, signal) => accept({ code, signal })));
}
async function compilerFixture(ignoreTermination = false) {
  const directory = await mkdtemp(join(tmpdir(), 'matrix-compiler-owner-'));
  directories.push(directory);
  await mkdir(join(directory, 'node_modules/typescript/lib'), { recursive: true });
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'package.json'), '{}');
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist', types: [], skipLibCheck: true }, include: ['src'] }));
  await writeFile(join(directory, 'src/index.ts'), 'export const value = 1;');
  const compiler = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
  // Execute the real compiler, but keep its successful process alive as a
  // controlled output writer to expose cancellation/ownership races reliably.
  await writeFile(join(directory, 'node_modules/typescript/lib/tsc.js'), `
    const fs = require('node:fs');
    fs.writeFileSync('compiler-pid', String(process.pid));
    process.exit = code => { if (code) throw new Error('Real compiler failed: ' + code); };
    require(${JSON.stringify(compiler)});
    const timer = setInterval(() => fs.appendFileSync('compiler-writes', 'x'), 10);
    process.on('SIGTERM', () => { if (!${JSON.stringify(ignoreTermination)}) setTimeout(() => { clearInterval(timer); process.exitCode = 143; }, 200); });
  `);
  return directory;
}
function start(directory: string) {
  const child = spawn(process.execPath, [script], { cwd: directory, stdio: 'ignore' });
  children.push(child);
  return child;
}

describe('incremental compiler cancellation and delivery', () => {
  it('runs successful cold and repeat CLI builds through the real compiler supervisor', async () => {
    const directory = await compilerFixture();
    const compiler = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
    await writeFile(join(directory, 'node_modules/typescript/lib/tsc.js'), `require(${JSON.stringify(compiler)});`);
    for (let run = 0; run < 2; run++) {
      const wrapper = start(directory);
      expect(await exited(wrapper)).toEqual({ code: 0, signal: null });
      expect(await readFile(join(directory, 'dist/index.js'), 'utf8')).toContain('value = 1');
      const cache = await readdir(join(directory, '.matrix-build-cache'));
      expect(cache.sort()).toEqual(['.matrix-build.json', '.matrix.tsbuildinfo']);
    }
  }, 15000);

  it('keeps ownership until the real compiler stops after wrapper cancellation', async () => {
    const directory = await compilerFixture();
    const wrapper = start(directory);
    const lock = join(directory, '.matrix-build-cache/.matrix-build.lock');
    await waitFor(() => exists(join(directory, 'compiler-writes')));
    compilerPids.push(Number(await readFile(join(directory, 'compiler-pid'), 'utf8')));
    wrapper.kill('SIGTERM');
    await new Promise(accept => setTimeout(accept, 50));
    expect(await readFile(join(lock, 'owner'), 'utf8')).toBe(String(wrapper.pid));
    expect(await exited(wrapper)).toEqual({ code: 143, signal: null });
    const writes = await readFile(join(directory, 'compiler-writes'), 'utf8');
    await new Promise(accept => setTimeout(accept, 100));
    expect(await readFile(join(directory, 'compiler-writes'), 'utf8')).toBe(writes);
    expect(await readdir(join(directory, '.matrix-build-cache'))).toEqual([]);
  }, 15000);

  it.skipIf(process.platform === 'win32')('does not reclaim a crashed wrapper lock while its compiler process group is still alive', async () => {
    const directory = await compilerFixture();
    const wrapper = start(directory);
    const lock = join(directory, '.matrix-build-cache/.matrix-build.lock');
    await waitFor(() => exists(join(directory, 'compiler-writes')));
    const compilerPid = Number(await readFile(join(directory, 'compiler-pid'), 'utf8'));
    compilerPids.push(compilerPid);
    try {
      const supervisor = Number(await readFile(join(lock, 'compiler'), 'utf8'));
      // Killing both supervisors leaves the actual compiler alive; its process
      // group must still prevent stale-owner recovery by the next build.
      process.kill(supervisor, 'SIGKILL');
      wrapper.kill('SIGKILL');
      await exited(wrapper);
      const runner = `import { buildTypescript } from ${JSON.stringify(new URL('../../scripts/build-typescript.mjs', import.meta.url).href)};
        await buildTypescript(${JSON.stringify(directory)}, async () => { process.exit(77); });`;
      const contender = spawn(process.execPath, ['--input-type=module', '--eval', runner], { stdio: 'ignore' });
      children.push(contender);
      await new Promise(accept => setTimeout(accept, 250));
      expect(contender.exitCode).toBeNull();
      expect(await readFile(join(lock, 'owner'), 'utf8')).toBe(String(wrapper.pid));
      contender.kill('SIGTERM');
      await exited(contender);
    } finally { process.kill(compilerPid, 'SIGKILL'); }
  }, 15000);

  it('terminates a compiler that ignores cancellation at the bounded compiler deadline', async () => {
    const directory = await compilerFixture(true);
    const preload = join(directory, 'deadline.cjs');
    // Scale only the two production budgets in these real subprocesses. The
    // timeout path and compiler TERM/KILL lifecycle otherwise run unchanged.
    await writeFile(preload, `const timer=global.setTimeout;global.setTimeout=(callback,ms,...args)=>timer(callback,ms===600000?1000:ms===5000?100:ms,...args);`);
    const wrapper = spawn(process.execPath, [script], { cwd: directory, stdio: 'ignore',
      env: { ...process.env, NODE_OPTIONS: `--require ${preload}` } });
    children.push(wrapper);
    await waitFor(() => exists(join(directory, 'compiler-writes')));
    compilerPids.push(Number(await readFile(join(directory, 'compiler-pid'), 'utf8')));
    expect(await exited(wrapper)).toEqual({ code: 124, signal: null });
    const writes = await readFile(join(directory, 'compiler-writes'), 'utf8');
    await new Promise(accept => setTimeout(accept, 100));
    expect(await readFile(join(directory, 'compiler-writes'), 'utf8')).toBe(writes);
    expect(await readdir(join(directory, '.matrix-build-cache'))).toEqual([]);
  }, 15000);

  it.skipIf(process.platform === 'win32')('stops the real compiler after an uncatchable wrapper crash before stale recovery', async () => {
    const directory = await compilerFixture();
    const wrapper = start(directory);
    const lock = join(directory, '.matrix-build-cache/.matrix-build.lock');
    await waitFor(() => exists(join(directory, 'compiler-writes')));
    const compilerPid = Number(await readFile(join(directory, 'compiler-pid'), 'utf8'));
    compilerPids.push(compilerPid);
    wrapper.kill('SIGKILL');
    await exited(wrapper);
    const runner = `import {buildTypescript} from ${JSON.stringify(new URL('../../scripts/build-typescript.mjs', import.meta.url).href)};
      process.exitCode=await buildTypescript(${JSON.stringify(directory)},async()=>0);`;
    const contender = spawn(process.execPath, ['--input-type=module', '--eval', runner], { stdio: 'ignore' });
    children.push(contender);
    expect((await exited(contender)).code).toBe(0);
    const writes = await readFile(join(directory, 'compiler-writes'), 'utf8');
    await new Promise(accept => setTimeout(accept, 100));
    expect(await readFile(join(directory, 'compiler-writes'), 'utf8')).toBe(writes);
    expect(await exists(join(lock, 'owner'))).toBe(false);
    expect(await readdir(join(directory, '.matrix-build-cache'))).toEqual(['.matrix-build.json']);
  }, 15000);

  it('allows a preparation disappearing during sweep but propagates other I/O errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'matrix-cache-sweep-'));
    directories.push(directory);
    const cache = join(directory, '.matrix-build-cache');
    const disappearing = join(cache, '.matrix-build.lock.prepare.2147483647.00000000-0000-4000-8000-000000000000');
    await mkdir(disappearing, { recursive: true });
    const module = new URL('../../scripts/build-typescript.mjs', import.meta.url).href;
    for (const errorCode of ['ENOENT', 'EACCES']) {
      const runner = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
        const original=fs.lstat; fs.lstat=async path => { if(String(path)===${JSON.stringify(disappearing)}) {
          if(${JSON.stringify(errorCode)}==='ENOENT')await fs.rm(path,{recursive:true,force:true});
          throw Object.assign(new Error('Sweep race'),{code:${JSON.stringify(errorCode)}}); } return original(path); };
        syncBuiltinESMExports(); const {buildTypescript}=await import(${JSON.stringify(module)});
        try { await buildTypescript(${JSON.stringify(directory)},async()=>0); process.exitCode=0; }
        catch(error) { process.exitCode=error.code==='EACCES'?42:1; }`;
      await mkdir(disappearing, { recursive: true });
      const child = spawn(process.execPath, ['--input-type=module', '--eval', runner], { stdio: 'ignore' });
      children.push(child);
      expect((await exited(child)).code).toBe(errorCode === 'ENOENT' ? 0 : 42);
    }
  });

  it('copies the incremental helper into Docker before any package build', async () => {
    const docker = await readFile(resolve('Dockerfile'), 'utf8');
    const copy = docker.indexOf('COPY scripts/build-typescript.mjs scripts/build-typescript.mjs');
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(docker.indexOf("RUN pnpm --filter '@matrix-os/observability' build"));
  });

  it('prunes staged compiler caches before release metadata and archives without touching source or symlink targets', async () => {
    const bundle = await readFile(resolve('scripts/build-host-bundle.sh'), 'utf8');
    const prune = bundle.split('\n').find(line => line.startsWith('find "$STAGE_DIR/app/packages"') && line.includes('.matrix-build-cache'));
    expect(prune).toBeDefined();
    expect(bundle.indexOf(prune!)).toBeLessThan(bundle.indexOf('node "$ROOT_DIR/scripts/host-bundle-release.mjs" write-release'));
    const stage = await mkdtemp(join(tmpdir(), 'matrix-cache-staging-'));
    directories.push(stage);
    await mkdir(join(stage, 'app/packages/a/.matrix-build-cache'), { recursive: true });
    await mkdir(join(stage, 'app/packages/b'), { recursive: true });
    await mkdir(join(stage, 'outside'));
    await writeFile(join(stage, 'outside/keep'), 'preserved');
    await symlink(join(stage, 'outside'), join(stage, 'app/packages/b/.matrix-build-cache'));
    await writeFile(join(stage, 'app/packages/a/runtime.js'), 'runtime');
    execFileSync('bash', ['-euc', prune!], { env: { ...process.env, STAGE_DIR: stage } });
    expect(await readdir(join(stage, 'app/packages/a'))).toEqual(['runtime.js']);
    expect(await readdir(join(stage, 'app/packages/b'))).toEqual([]);
    expect(await readFile(join(stage, 'outside/keep'), 'utf8')).toBe('preserved');
  });
});
