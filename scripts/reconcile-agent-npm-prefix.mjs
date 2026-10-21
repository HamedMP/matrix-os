#!/usr/bin/env node
// Run as the runtime owner after either installer. Keep Hermes's private Node;
// only its npm global destination belongs to the shared Matrix tool prefix.
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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

async function requireDirectory(path) {
  if (!(await metadata(path))?.isDirectory()) throw new Error('Agent npm directory must not be a symlink');
}

async function pmRuntime(hermes) {
  const tools = join(hermes, 'tools');
  if (!(await metadata(tools))) return undefined;
  await requireDirectory(tools);
  const factsPath = join(tools, 'facts.json');
  const info = await metadata(factsPath);
  if (!info) return undefined;
  if (!info.isFile() || info.size > 65536) throw new Error('Invalid agent PM facts file');
  const facts = JSON.parse(await readFile(factsPath, 'utf8'));
  if (facts?.schema !== 1 || !facts.packages || typeof facts.packages !== 'object' || Array.isArray(facts.packages)) {
    throw new Error('Unsupported agent PM facts');
  }
  const node = facts.packages.node;
  if (node === undefined) return undefined; // PM has not installed Node yet.
  if (typeof node?.entry !== 'string' || !/^node-[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(node.entry)) {
    throw new Error('Invalid agent PM Node entry');
  }
  const prefix = join(tools, node.entry);
  await requireDirectory(prefix);
  await requireDirectory(join(prefix, 'bin'));
  if (!(await metadata(join(prefix, 'bin/node')))?.isFile()) throw new Error('Missing agent PM Node binary');
  const npm = facts.packages.npm;
  let cli;
  if (npm !== undefined) {
    if (typeof npm?.entry !== 'string' || !/^npm-[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(npm.entry)) throw new Error('Invalid agent PM npm entry');
    const npmPrefix = join(tools, npm.entry);
    await requireDirectory(npmPrefix);
    await requireDirectory(join(npmPrefix, 'bin'));
    cli = await realpath(join(npmPrefix, 'bin/npm'));
    const within = relative(await realpath(npmPrefix), cli);
    if (within.startsWith('..') || isAbsolute(within) || !(await metadata(cli))?.isFile()) throw new Error('Invalid agent PM npm command');
  }
  return { prefix, cli };
}

async function defaultPmGlobalConfig(home, hermes, prefix, pm) {
  if ('npm_config_globalconfig' in process.env || 'NPM_CONFIG_GLOBALCONFIG' in process.env || !pm?.cli) return undefined;
  const config = join(hermes, 'matrix-npm/npmrc');
  if (!(await metadata(config))) return undefined;
  await requireDirectory(dirname(config));
  if (!(await metadata(config))?.isFile()) throw new Error('Agent npm configuration must be a regular file');
  const pmGlobal = join(await realpath(pm.prefix), 'etc/npmrc');
  // A pre-existing default file may carry operator options. Do not mask it,
  // copy potentially secret settings, or alter either package/config tree.
  if (await metadata(pmGlobal) || await metadata(join(prefix, 'etc/npmrc'))) return undefined;
  let selected;
  try {
    selected = execFileSync(join(pm.prefix, 'bin/node'), [pm.cli, 'config', 'get', 'globalconfig'], {
      cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 5_000, maxBuffer: 8192,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error('Unable to inspect agent npm config', { cause: error });
  }
  // Existing userconfig/globalconfig choices keep their precedence. Matrix
  // supplies only the otherwise-default PM global config, outside the store.
  return selected === pmGlobal ? config : undefined;
}

async function configurePrefix(path, prefix) {
  if (!(await metadata(dirname(path)))) await mkdir(dirname(path));
  await requireDirectory(dirname(path));
  const info = await metadata(path);
  if (info && !info.isFile()) throw new Error('Agent npm configuration must be a regular file');
  const contents = info ? await readFile(path, 'utf8') : '';
  const retained = contents.split(/\r?\n/).filter(line => !/^\s*prefix\s*=/i.test(line));
  while (retained.at(-1) === '') retained.pop();
  const next = [...retained, `prefix=${prefix}`, ''].join('\n');
  if (next === contents) return;
  const temporary = `${path}.matrix-${randomUUID()}`;
  try {
    await writeFile(temporary, next, { flag: 'wx', mode: info ? info.mode & 0o777 : 0o644 });
    if (info) await chmod(temporary, info.mode & 0o777);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function reconcile() {
  if (process.argv[2] === '--globalconfig' && process.geteuid?.() === 0) return;
  const home = absolutePath(process.env.MATRIX_RUNTIME_HOME ?? process.env.MATRIX_HOME ?? '/home/matrix/home');
  const hermes = absolutePath(process.env.HERMES_HOME ?? join(home, '.hermes'));
  const prefix = absolutePath(process.env.MATRIX_NODE_PREFIX ?? '/opt/matrix/runtime/node');
  // Legacy hosts have a root-owned runtime tree with no etc directory.
  // Runtime npm already defaults to its executable prefix; preserve its config
  // rather than requiring privilege just to repair Hermes's owner-local npm.
  // Do not create an uninstalled Hermes tree or edit the owner's ~/.npmrc.
  if (await metadata(hermes)) await requireDirectory(hermes);
  const pm = await pmRuntime(hermes);
  if (process.argv[2] === '--globalconfig') {
    const config = await defaultPmGlobalConfig(home, hermes, prefix, pm);
    if (config) process.stdout.write(`${config}\n`);
    return;
  }
  if (await metadata(join(hermes, 'node'))) {
    await requireDirectory(join(hermes, 'node'));
    await configurePrefix(join(hermes, 'node/etc/npmrc'), prefix);
  }
  // PM verifies whole package-tree digests on explicit installs. Never put
  // configuration in those entries or rewrite their recorded facts/digests.
  if (pm) await configurePrefix(join(hermes, 'matrix-npm/npmrc'), prefix);

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
