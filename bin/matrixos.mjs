#!/usr/bin/env node
// Launcher for the TS CLI. pnpm's bin wrapper invokes `node <path>` and
// ignores the shebang on the .ts entry, and tsx 4.21+ refuses to register
// via `node:module.register`. Cleanest path: re-exec node with --import=tsx.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const tsxEntry = resolve(here, '..', 'node_modules', 'tsx');

if (!existsSync(tsxEntry)) {
  console.error(
    'tsx not found. Run `pnpm install` in the matrix-os repo before invoking the matrix CLI.',
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', resolve(here, 'matrixos.ts'), ...process.argv.slice(2)],
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
