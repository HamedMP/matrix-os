#!/usr/bin/env node
// Published-package entry for `matrix` / `matrixos` / `mos` when installed via
// `npm i -g @finnaai/matrix`. Re-execs with the tsx loader so Node can
// import the .ts CLI sources directly. Mirrors bin/matrixos.mjs in the
// monorepo, but resolves tsx from the package's own node_modules.
//
// `--import tsx` as a bare specifier is resolved against CWD. When the
// CLI is installed globally and the user runs it from any directory,
// Node can't find tsx. Pass the absolute loader URL so resolution is
// path-based and CWD-independent.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { findTsxLoader } from '../src/lib/find-tsx-loader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const tsxLoader = findTsxLoader(pkgRoot);
if (!tsxLoader) {
  console.error(
    'matrix CLI: tsx loader not found. Reinstall with `npm i -g @finnaai/matrix`.',
  );
  process.exit(1);
}

const cliEntry = resolve(pkgRoot, 'src', 'cli', 'index.ts');
if (!existsSync(cliEntry)) {
  console.error('matrix CLI: entry not found. Reinstall with `npm i -g @finnaai/matrix`.');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(tsxLoader).href, cliEntry, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(`Failed to launch matrix CLI: ${err.message}`);
  process.exit(1);
});
