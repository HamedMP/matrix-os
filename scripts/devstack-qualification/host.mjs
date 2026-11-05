import { access, chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runCommandSync } from '../local-production-parity/commands.mjs';

export function options(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: false, options: {
    mutagen: { type: 'string' }, container: { type: 'string' }, 'owner-label': { type: 'string' },
    'target-root': { type: 'string' }, tsx: { type: 'string' }, report: { type: 'string' },
    count: { type: 'string', default: '3' }, user: { type: 'string', default: 'node' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { help: true };
  if (positionals.length || ['mutagen', 'container', 'owner-label', 'target-root', 'tsx', 'report'].some(k => !values[k])) throw new Error('Required flags: --mutagen --container --owner-label --target-root --tsx --report');
  const count = Number(values.count);
  if (!Number.isSafeInteger(count) || count < 3 || count > 8) throw new Error('Qualification count must be 3..8 (a test safety cap, not a product limit)');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(values.container) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(values.user)) throw new Error('Invalid container/user');
  const match = /^([a-zA-Z0-9._/-]{1,128})=([a-zA-Z0-9_.:-]{1,128})$/.exec(values['owner-label']);
  if (!match) throw new Error('Owner label must be an explicit key=value');
  for (const key of ['target-root', 'tsx']) {
    const path = values[key];
    if (posix.normalize(path) !== path || !/^\/[a-zA-Z0-9._/-]+$/.test(path) || path.split('/').includes('..') || path.split('/').filter(Boolean).length < 3) throw new Error(`Unsafe absolute ${key}`);
  }
  if (!isAbsolute(values.report) || !isAbsolute(values.mutagen)) throw new Error('Mutagen/report paths must be absolute');
  return { ...values, count, labelKey: match[1], labelValue: match[2] };
}

export function command(command, args, { cwd, env, timeoutMs = 30_000 } = {}) {
  return runCommandSync(command, args, { cwd, env, capture: true, timeoutMs });
}

export function assertOwner(config, expected = config.labelValue) {
  if (command('docker', ['context', 'show']).trim() !== 'orbstack') throw new Error('Qualification requires the local orbstack Docker context');
  const endpoint = JSON.parse(command('docker', ['context', 'inspect', 'orbstack', '--format', '{{json .Endpoints.docker.Host}}']));
  const system = command('docker', ['--context', 'orbstack', 'info', '--format', '{{.OperatingSystem}}']).trim();
  if (!endpoint.startsWith('unix://') || system !== 'OrbStack') throw new Error('Qualification requires a local Unix-socket OrbStack engine');
  const labels = JSON.parse(command('docker', ['--context', 'orbstack', 'inspect', '--format', '{{json .Config.Labels}}', config.container]));
  if (!labels || labels[config.labelKey] !== expected) throw new Error('Container ownership label mismatch');
  const state = command('docker', ['--context', 'orbstack', 'inspect', '--format', '{{.State.Status}}', config.container]).trim();
  if (state !== 'running') throw new Error('The explicitly owned container must already be running');
  const id = command('docker', ['--context', 'orbstack', 'inspect', '--format', '{{.Id}}', config.container]).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid pinned container identity');
  return id;
}

export async function localFixture(config) {
  await access(config.mutagen, constants.X_OK);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ is required');
  const root = await mkdtemp('/tmp/matrix-devstack-sync-');
  try {
    await chmod(root, 0o700);
    const env = { ...process.env, MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen'), DOCKER_CONTEXT: 'orbstack' };
    const repo = join(root, 'repo');
    await mkdir(repo);
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
    command('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--template=', '--initial-branch=main', repo], { env: gitEnv });
    return { root: await realpath(root), repo, env, gitEnv, worktrees: [] };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function createWorktrees(local, config, service) {
  await writeFile(join(local.repo, 'service.mjs'), service);
  await writeFile(join(local.repo, 'revision.mjs'), 'export const revision = "initial";\n');
  command('git', ['-c', 'core.hooksPath=/dev/null', 'add', 'service.mjs', 'revision.mjs'], { cwd: local.repo, env: local.gitEnv });
  command('git', ['-c', 'user.name=DevStack fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test: seed isolated sync fixture'], { cwd: local.repo, env: local.gitEnv });
  for (let i = 0; i < config.count; i++) {
    const source = join(local.root, `source-${i}`);
    const branch = i === 0 ? 'feature/collision-a' : i === 1 ? 'feature_collision-a' : `feature/parallel-${i}`;
    command('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', branch, source, 'main'], { cwd: local.repo, env: local.gitEnv });
    const id = `w-${i}-${createHash('sha256').update(await realpath(source)).digest('hex').slice(0, 8)}`;
    const revision = `${id}-initial`;
    await writeFile(join(source, 'revision.mjs'), `export const revision = ${JSON.stringify(revision)};\n`);
    await writeFile(join(source, '.env.sentinel'), 'SYNTHETIC_NOT_A_SERVICE_CREDENTIAL=must-not-transfer\n', { mode: 0o600 });
    local.worktrees.push({ id, source, branch, revision });
  }
  return local.worktrees;
}

export async function atomicRevision(workspace, revision) {
  const path = join(workspace.source, 'revision.mjs');
  await writeFile(`${path}.tmp`, `export const revision = ${JSON.stringify(revision)};\n`);
  const { rename } = await import('node:fs/promises');
  await rename(`${path}.tmp`, path);
  workspace.revision = revision;
}

export async function cleanupLocal(local) {
  const failures = [];
  for (const workspace of local.worktrees) {
    try { command('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', workspace.source], { cwd: local.repo, env: local.gitEnv }); }
    catch (error) { failures.push(String(error.message).slice(0, 1000)); }
  }
  if (!failures.length) await rm(local.root, { recursive: true, force: true });
  return { removed: !failures.length, failures };
}

export async function saveReport(path, report) {
  const target = resolve(path);
  const { dirname } = await import('node:path');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (!(await lstat(dirname(target))).isDirectory()) throw new Error('Report parent must be a directory');
  const body = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Report exceeds bound');
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(body); } finally { await handle.close(); }
}
