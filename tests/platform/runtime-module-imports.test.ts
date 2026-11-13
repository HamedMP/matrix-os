import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = process.cwd();
const helper = 'packages/platform/src/runtime-module-imports.ts';
const pause = (ms: number) => new Promise(accept => setTimeout(accept, ms));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'matrix-platform-imports-'));
  try {
    for (const path of ['platform/src', 'platform/dist', 'gateway/src/integrations', 'gateway/dist/integrations', 'gateway/dist-other']) {
      await mkdir(join(directory, 'packages', path), { recursive: true });
    }
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    await symlink(resolve(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await copyFile(resolve(root, helper), join(directory, helper));
    await writeFile(join(directory, 'packages/gateway/src/integrations/routes.ts'), 'export { value } from "./value.js";');
    await writeFile(join(directory, 'packages/gateway/src/integrations/value.ts'), 'export const value: string = "SOURCE_0";');
    await writeFile(join(directory, 'packages/gateway/dist/integrations/routes.js'), 'export const value = "DIST_ONLY";');
    await writeFile(join(directory, 'packages/gateway/dist-other/neighbor.js'), 'export const value = "UNRELATED";');
    for (const mode of ['src', 'dist']) {
      await writeFile(join(directory, `packages/platform/${mode}/neighbor.js`), 'export const value = "PLATFORM_NEIGHBOR";');
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const consumer = `
  import { createRuntimeModuleImporter } from './runtime-module-imports.js';
  const load = createRuntimeModuleImporter(import.meta.url);
  const { value } = await load('../../gateway/dist/integrations/routes.js');
  const builtin = await load('node:path');
  const neighbor = await load('./neighbor.js');
  const unrelated = await load('../../gateway/dist-other/neighbor.js');
  console.log('RUNTIME_VALUE=' + value + ';BUILTIN=' + builtin.basename('/a/module')
    + ';NEIGHBOR=' + neighbor.value + ';UNRELATED=' + unrelated.value);
`;

it('reloads Gateway source edits through a source Platform runtime importer', async () => {
  const directory = await fixture();
  let child: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  let output = '';
  let failure: Error | undefined;
  try {
    const entry = join(directory, 'packages/platform/src/platform-startup.ts');
    await writeFile(entry, `${consumer}\nsetInterval(() => {}, 1000);`);
    // Exercise the actual loader and dynamic-import watch graph in a separate
    // tsx process. No live Platform bootstrap, auth, database or provider runs.
    child = spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', '--clear-screen=false', entry], {
      cwd: directory, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    closed = new Promise(accept => child!.once('close', accept));
    child.once('error', error => { failure = error; });
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_000); };
    child.stdout!.on('data', append);
    child.stderr!.on('data', append);
    const waitFor = async (value: string) => {
      const deadline = performance.now() + 8000;
      while (!output.includes(`RUNTIME_VALUE=${value};BUILTIN=module;NEIGHBOR=PLATFORM_NEIGHBOR;UNRELATED=UNRELATED`)) {
        if (failure) throw failure;
        if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Platform watcher exited: ${output}`);
        if (performance.now() >= deadline) throw new Error(`Platform did not consume ${value}: ${output}`);
        await pause(25);
      }
    };
    await waitFor('SOURCE_0');
    const value = join(directory, 'packages/gateway/src/integrations/value.ts');
    for (let revision = 1; revision <= 3; revision++) {
      await writeFile(`${value}.tmp`, `export const value: string = "SOURCE_${revision}";`);
      await rename(`${value}.tmp`, value);
      await waitFor(`SOURCE_${revision}`);
    }
    expect(await readFile(join(directory, 'packages/gateway/dist/integrations/routes.js'), 'utf8')).toContain('DIST_ONLY');
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stop = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === 'win32') child!.kill(signal);
          else process.kill(-child!.pid!, signal);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      stop('SIGTERM');
      const escalation = setTimeout(() => stop('SIGKILL'), 1000);
      try { await closed; } finally { clearTimeout(escalation); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('keeps the compiled importer on emitted Gateway modules under native Node', async () => {
  const directory = await fixture();
  try {
    const compiled = ts.transpileModule(await readFile(resolve(root, helper), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      reportDiagnostics: true,
    });
    expect(compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([]);
    await writeFile(join(directory, 'packages/platform/dist/runtime-module-imports.js'), compiled.outputText);
    const entry = join(directory, 'packages/platform/dist/platform-startup.js');
    await writeFile(entry, consumer);
    // A compiled caller must work with source completely absent, without tsx
    // or any runtime TypeScript resolver in the child process.
    await rm(join(directory, 'packages/gateway/src'), { recursive: true });
    const result = spawnSync(process.execPath, [entry], {
      cwd: directory, encoding: 'utf8', timeout: 8000, maxBuffer: 16_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('RUNTIME_VALUE=DIST_ONLY;BUILTIN=module;NEIGHBOR=PLATFORM_NEIGHBOR;UNRELATED=UNRELATED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
