#!/usr/bin/env node
// Published-package entry for `matrix` / `matrixos` when installed via
// `npm i -g @matrix-os/cli`. Re-execs with the tsx loader so Node can
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

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

// Walk up from the bin directory looking for a tsx loader. When installed
// globally via npm, tsx lives under the package's own node_modules. When
// installed via pnpm, it may be hoisted one or two levels up.
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

const tsxLoader = findTsxLoader(pkgRoot);
if (!tsxLoader) {
  console.error(
    'matrix CLI: tsx loader not found. Reinstall with `npm i -g @matrix-os/cli`.',
  );
  process.exit(1);
}

const cliEntry = resolve(pkgRoot, 'src', 'cli', 'index.ts');
if (!existsSync(cliEntry)) {
  console.error(`matrix CLI: entry not found at ${cliEntry}. Reinstall with \`npm i -g @matrix-os/cli\`.`);
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
