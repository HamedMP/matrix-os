#!/usr/bin/env node
// launchd/systemd entry. Plain `node` can't import .ts files, so we re-exec
// with `--import tsx` to get the loader. Mirrors bin/matrixos.mjs.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// Walk up to find a node_modules/tsx -- works whether installed locally or
// via pnpm workspaces.
function findTsx(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'node_modules', 'tsx'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const tsxRoot = findTsx(here);
if (!tsxRoot) {
  console.error('Daemon launcher: tsx not found. Run `pnpm install` in the matrix-os repo.');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', resolve(here, 'index.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(`Failed to launch daemon: ${err.message}`);
  process.exit(1);
});
