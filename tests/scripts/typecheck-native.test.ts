import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const load = () => import(pathToFileURL(join(root, 'scripts/typecheck.mjs')).href);
const configs = [
  'packages/observability/tsconfig.json', 'packages/integrations-mcp/tsconfig.json',
  'packages/gateway/tsconfig.json', 'packages/platform/tsconfig.typecheck.json',
  'packages/proxy/tsconfig.json', 'packages/edge-router/tsconfig.json',
  'desktop/tsconfig.json', 'desktop/tsconfig.node.json',
];

describe('native standalone typecheck', () => {
  it('checks all eight original projects with the pinned native entry point', async () => {
    const { runTypechecks } = await load();
    const calls: { binary: string; args: string[]; options: { cwd: string; timeout: number } }[] = [];
    const status = runTypechecks({ root, nativeEntry: '/compiler/bin/tsc', run: (binary: string, args: string[], options: typeof calls[number]['options']) => {
      calls.push({ binary, args, options }); return { status: 0 };
    } });
    expect(status).toBe(0);
    expect(calls.map(call => join(call.options.cwd, call.args[call.args.indexOf('-p') + 1]).slice(root.length + 1))).toEqual(configs);
    expect(calls.every(call => call.binary === process.execPath && call.args[0] === '/compiler/bin/tsc' && call.args.includes('--noEmit') && call.options.timeout === 180_000)).toBe(true);
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(scripts.devDependencies['@typescript/native']).toBe('npm:typescript@7.0.2');
    expect(scripts.scripts['typecheck:run']).toBe('node scripts/typecheck.mjs');
    expect(scripts.scripts.typecheck).toBe('bun run typecheck:build-kernel && bun run typecheck:run');
  });

  it('preserves legacy ambient globals without injecting Node into browser or Cloudflare configs', async () => {
    const { runTypechecks } = await load();
    const argsByProject: string[][] = [];
    runTypechecks({ root, nativeEntry: '/compiler/bin/tsc', run: (_binary: string, args: string[]) => { argsByProject.push(args); return { status: 0 }; } });
    expect(argsByProject.slice(0, 5).map(args => args.slice(args.indexOf('--types'), args.indexOf('--types') + 2))).toEqual(Array(5).fill(['--types', '*']));
    expect(argsByProject.slice(5).every(args => !args.includes('--types'))).toBe(true);
    expect(argsByProject.every(args => args.includes('--noUncheckedSideEffectImports') && args[args.indexOf('--noUncheckedSideEffectImports') + 1] === 'false')).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'desktop/tsconfig.json'), 'utf8')).compilerOptions.types).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'packages/edge-router/tsconfig.json'), 'utf8')).compilerOptions.types).toEqual(['@cloudflare/workers-types']);
  });

  it('offers the same eight projects through each package’s legacy compiler for parity checks', async () => {
    const { runTypechecks } = await load();
    const calls: { binary: string; args: string[]; cwd: string }[] = [];
    expect(runTypechecks({ root, compiler: 'legacy', run: (binary: string, args: string[], options: { cwd: string }) => { calls.push({ binary, args, cwd: options.cwd }); return { status: 0 }; } })).toBe(0);
    expect(calls.map(call => join(call.cwd, call.args[call.args.indexOf('-p') + 1]).slice(root.length + 1))).toEqual(configs);
    expect(calls.every(call => call.binary === 'pnpm' && call.args.slice(0, 2).join(' ') === 'exec tsc' && !call.args.includes('--types') && !call.args.includes('--noUncheckedSideEffectImports'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'packages/gateway/package.json'), 'utf8')).devDependencies.typescript).toBe('^5.9.3');
  });

  it('propagates a project failure and never silently falls back to a different compiler', async () => {
    const { runTypechecks } = await load();
    let calls = 0;
    expect(runTypechecks({ root, nativeEntry: '/compiler/bin/tsc', run: () => ({ status: ++calls === 3 ? 2 : 0 }) })).toBe(2);
    expect(calls).toBe(3);
    expect(() => runTypechecks({ root, compiler: 'unknown', run: () => { throw new Error('must not launch'); } })).toThrow('Unknown typecheck compiler');
    expect(() => runTypechecks({ root, nativeEntry: '/compiler/bin/tsc', run: () => ({ status: null, error: new Error('spawn failed') }) })).toThrow('spawn failed');
    expect(() => runTypechecks({ root, nativeEntry: '/compiler/bin/tsc', run: () => ({ status: null, signal: 'SIGTERM' }) })).toThrow('SIGTERM');
  });

  it('retains the JavaScript compiler API used by framework tools and package builds', () => {
    for (const directory of ['shell', 'desktop', 'packages/gateway']) {
      const require = createRequire(join(root, directory, 'package.json'));
      const compiler = require('typescript');
      expect(compiler.version, directory).toBe('5.9.3');
      expect(typeof compiler.createProgram, directory).toBe('function');
    }
    const require = createRequire(join(root, 'package.json'));
    expect(require('@typescript/native').version).toBe('7.0.2');
  });

  it('rejects unknown compiler or extra CLI arguments before launching checks', () => {
    for (const args of [['unknown'], ['native', '--skip-checks']]) {
      const result = spawnSync(process.execPath, [join(root, 'scripts/typecheck.mjs'), ...args], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384 });
      expect(result.status, result.error?.message).toBe(1);
      expect(result.stderr).toContain('[typecheck] Failed:');
      expect(result.stdout).not.toContain('packages/');
    }
  });
});
