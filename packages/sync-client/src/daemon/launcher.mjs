#!/usr/bin/env node
// launchd/systemd entry. Plain `node` can't import .ts files, so we re-exec
// with `--import <tsx-loader>` to get the TS loader. Mirrors bin/matrixos.mjs.
//
// `--import tsx` as a bare specifier is resolved against Node's CWD, which
// is NOT this file's directory when invoked by launchd (launchd sets CWD to
// the plist's WorkingDirectory, and the user might be running from anywhere
// if testing by hand). Pass the absolute loader URL to make resolution
// path-based and CWD-independent.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// Walk up to find a node_modules/tsx/dist/loader.mjs -- works whether
// installed locally or via pnpm workspaces.
function findTsxLoader(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
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
  console.error('Daemon launcher: tsx loader not found. Run `pnpm install` in the matrix-os repo.');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(tsxLoader).href, resolve(here, 'index.ts'), ...process.argv.slice(2)],
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
