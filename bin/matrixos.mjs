#!/usr/bin/env node
// Launcher for the TS CLI. pnpm's bin wrapper invokes `node <path>` and
// ignores the shebang on the .ts entry, and tsx 4.21+ refuses to register
// via `node:module.register`. Cleanest path: re-exec node with --import=tsx.
//
// CRITICAL: `--import tsx` is resolved by Node against the CWD, not this
// launcher file. When the CLI is installed globally via `pnpm link --global`
// and run from a directory without a tsx dep (e.g. the user's project),
// Node throws `ERR_MODULE_NOT_FOUND`. Pass the absolute loader URL instead
// so resolution is path-based and CWD-independent.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// Walk up from this file looking for tsx. Works whether the launcher is
// the repo-root `bin/matrixos.mjs` (tsx in `<repo>/node_modules`), invoked
// via `pnpm link --global` from any cwd, or via a packaged install where
// tsx may be hoisted one or two levels up.
function findTsxLoader(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const tsxLoader = findTsxLoader(here);
if (!tsxLoader) {
  console.error(
    'matrix CLI: tsx loader not found. Run `pnpm install` in the matrix-os repo before invoking the matrix CLI.',
  );
  process.exit(1);
}

const cliEntry = resolve(here, 'matrixos.ts');
if (!existsSync(cliEntry)) {
  console.error(`matrix CLI: entry not found at ${cliEntry}.`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(tsxLoader).href, cliEntry, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(`Failed to launch matrix CLI: ${err.message}`);
  process.exit(1);
});
