#!/usr/bin/env node
// Run as the runtime owner after either installer. Keep Hermes's private Node;
// only its npm global destination belongs to the shared Matrix tool prefix.
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function absolutePath(value) {
  if (!isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Invalid agent npm path');
  return resolve(value);
}

async function metadata(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function configurePrefix(path, prefix) {
  const info = await metadata(path);
  if (info && !info.isFile()) throw new Error('Agent npm configuration must be a regular file');
  const contents = info ? await readFile(path, 'utf8') : '';
  const retained = contents.split(/\r?\n/).filter(line => !/^\s*prefix\s*=/i.test(line));
  while (retained.at(-1) === '') retained.pop();
  const next = [...retained, `prefix=${prefix}`, ''].join('\n');
  if (next === contents) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.matrix-${randomUUID()}`;
  try {
    await writeFile(temporary, next, { flag: 'wx', mode: info ? info.mode & 0o777 : 0o644 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function reconcile() {
  const home = absolutePath(process.env.MATRIX_RUNTIME_HOME ?? process.env.MATRIX_HOME ?? '/home/matrix/home');
  const hermes = absolutePath(process.env.HERMES_HOME ?? join(home, '.hermes'));
  const prefix = absolutePath(process.env.MATRIX_NODE_PREFIX ?? '/opt/matrix/runtime/node');
  // Legacy hosts have a root-owned runtime tree with no etc directory.
  // Runtime npm already defaults to its executable prefix; preserve its config
  // rather than requiring privilege just to repair Hermes's owner-local npm.
  // Do not create an uninstalled Hermes tree or edit the owner's ~/.npmrc.
  if (await metadata(join(hermes, 'node'))) {
    await configurePrefix(join(hermes, 'node/etc/npmrc'), prefix);
  }

  const localCodex = join(home, '.local/bin/codex');
  if (!(await metadata(localCodex))?.isSymbolicLink()) return;
  const previous = await readlink(localCodex);
  const npmShim = join(home, '.local/lib/node_modules/@openai/codex/bin/codex.js');
  if (resolve(dirname(localCodex), previous) !== npmShim) return;
  const managedCodex = join(prefix, 'bin/codex');
  try { await access(managedCodex, constants.X_OK); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return;
    throw error;
  }
  // Keep the old package bytes. Repoint the same command path so an existing
  // shell hash also reaches the managed executable without deleting user data.
  const temporary = `${localCodex}.matrix-${randomUUID()}`;
  try {
    await symlink(managedCodex, temporary);
    await rename(temporary, localCodex);
  } finally { await rm(temporary, { force: true }); }
}

try { await reconcile(); }
catch (error) {
  console.error('Matrix agent npm prefix reconciliation failed:', error.code ?? error.message);
  process.exitCode = 1;
}
