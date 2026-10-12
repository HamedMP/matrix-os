import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projects = [
  ['packages/observability', 'tsconfig.json', true],
  ['packages/integrations-mcp', 'tsconfig.json', true],
  ['packages/gateway', 'tsconfig.json', true],
  ['packages/platform', 'tsconfig.typecheck.json', true],
  ['packages/proxy', 'tsconfig.json', true],
  ['packages/edge-router', 'tsconfig.json', false],
  ['desktop', 'tsconfig.json', false],
  ['desktop', 'tsconfig.node.json', false],
];

// Use the alias directly: package-local tsc must remain TypeScript 5 for builds
// and framework tools that import the JavaScript compiler API.
export function runTypechecks({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  compiler = 'native', nativeEntry, run = spawnSync,
} = {}) {
  if (!['native', 'legacy'].includes(compiler)) throw new Error(`Unknown typecheck compiler: ${compiler}`);
  if (compiler === 'native' && !nativeEntry) {
    const require = createRequire(join(root, 'package.json'));
    nativeEntry = join(dirname(require.resolve('@typescript/native/package.json')), 'bin', 'tsc');
  }
  for (const [directory, config, legacyAmbientTypes] of projects) {
    const args = ['--noEmit', '-p', config];
    if (compiler === 'native') {
      // TS7 stopped loading visible @types packages implicitly. Preserve the
      // TS5 environment; browser and edge configs retain their explicit types.
      if (legacyAmbientTypes) args.push('--types', '*');
      // TS7 changed this default; keep the existing TS5 side-effect policy.
      args.push('--noUncheckedSideEffectImports', 'false');
    }
    console.log(`[typecheck:${compiler}] ${directory}/${config}`);
    const result = run(compiler === 'native' ? process.execPath : 'pnpm',
      compiler === 'native' ? [nativeEntry, ...args] : ['exec', 'tsc', ...args],
      { cwd: join(root, directory), stdio: 'inherit', timeout: 180_000 });
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`Typecheck terminated: ${result.signal ?? 'unknown signal'}`);
    if (result.status !== 0) return result.status;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: typecheck.mjs [native|legacy]');
    process.exitCode = runTypechecks({ compiler: process.argv[2] ?? 'native' });
  } catch (error) {
    console.error('[typecheck] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
