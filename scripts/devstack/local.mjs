import { statSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, readdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { runCommandSync } from '../local-production-parity/commands.mjs';

export const units = ['matrix-scope-runtime.service', 'matrix-devstack-gateway.service'];
export const shellUnit = 'matrix-devstack-shell.service';
const purpose = 'ENG-432-local-worktree';
const slug = /^[a-z0-9][a-z0-9-]{0,62}$/;
const revision = /^(unknown|[a-f0-9]{7,64})$/;
export function redact(value = '') {
  return String(value).replace(/("[^"]*(?:token|secret|password|api[_-]?key)[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted]"').replace(/\b(?:bearer)\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b([\w-]*(?:token|secret|password|api[_-]?key)[\w-]*\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xoxb|xoxp)[-_][A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 32768);
}
export function commandRunner(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', env: { ...process.env, ORBENV: '' } });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.error ? `Command failed: ${result.error.code}` : result.stderr ?? '' };
}
async function plainFile(path) {
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('symlink paths are not accepted');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid bounded manifest file');
  return JSON.parse(await readFile(path, 'utf8'));
}
function gitIdentity(worktree) {
  const path = realpathSync(runCommandSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { capture: true }));
  const stat = statSync(path);
  return JSON.stringify({ path, dev: stat.dev, ino: stat.ino });
}
async function validate(manifest) {
  const keys = ['version', 'id', 'worktree', 'machine', 'preview', 'sourceRoot', 'managedUnits', 'sourceSHA', 'appliedRevision', 'capabilities'];
  if (!manifest || typeof manifest !== 'object' || Object.keys(manifest).some(key => !keys.includes(key))) throw new Error('Invalid local manifest fields');
  if (manifest.version !== 1 || typeof manifest.id !== 'string' || !slug.test(manifest.id) || !/^devstack-[a-z0-9][a-z0-9-]{0,54}$/.test(manifest.machine)
    || manifest.sourceRoot !== '/opt/matrix/app' || ![units, [...units, shellUnit]].some(allowed => JSON.stringify(manifest.managedUnits) === JSON.stringify(allowed))
    || !revision.test(manifest.sourceSHA) || !revision.test(manifest.appliedRevision)
    || !manifest.capabilities || Object.keys(manifest.capabilities).some(key => key !== 'sourceSync') || !['unknown', 'external-one-way'].includes(manifest.capabilities.sourceSync)) throw new Error('Invalid local manifest');
  const url = new URL(manifest.preview);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Invalid HTTPS preview');
  if (typeof manifest.worktree !== 'string' || !isAbsolute(manifest.worktree) || await realpath(manifest.worktree) !== manifest.worktree) throw new Error('Worktree must be canonical, absolute and not a symlink');
  const top = runCommandSync('git', ['-C', manifest.worktree, 'rev-parse', '--show-toplevel'], { capture: true });
  if (await realpath(top) !== manifest.worktree) throw new Error('Pinned Git worktree mismatch');
  return manifest;
}

export function createAdapter({ registry = process.env.DEVSTACK_STATE_DIR ?? join(homedir(), '.matrixos', 'devstack'), capacity = Number(process.env.DEVSTACK_CAPACITY ?? 3), runner = commandRunner } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw new Error('Invalid local capacity');
  async function init() {
    await mkdir(registry, { recursive: true, mode: 0o700 });
    if (await realpath(registry) !== resolve(registry)) throw new Error('Registry symlinks are not accepted');
    const stat = await lstat(registry);
    if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Registry must be owned and private (0700)');
  }
  async function locked(action) {
    await init();
    const path = join(registry, '.lock');
    const lock = await open(path, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw new Error('Registry locked; inspect the owner process before removing a stale .lock'); throw error; });
    try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
    finally { await lock.close(); await unlink(path); }
  }
  function statePath(id) { if (typeof id !== 'string' || !slug.test(id)) throw new Error('Invalid instance id'); return join(registry, `${id}.json`); }
  async function get(id) { const record = await plainFile(statePath(id)); await validate(record.manifest); if (record.gitIdentity !== gitIdentity(record.manifest.worktree)) throw new Error('Pinned Git worktree identity changed'); return record; }
  async function save(record) {
    const path = statePath(record.manifest.id);
    const temp = `${path}.${process.pid}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.close(); await rename(temp, path); }
    finally { await handle.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function invoke(manifest, user, args) {
    const result = await runner('orb', ['-m', manifest.machine, '-u', user, ...args]);
    return { code: Number.isInteger(result.code) ? result.code : 1, stdout: redact(result.stdout), stderr: redact(result.stderr) };
  }
  async function owner(manifest) {
    await validate(manifest);
    const result = await invoke(manifest, 'root', ['cat', '/opt/matrix/.devstack-owner']);
    let marker;
    try { marker = JSON.parse(result.stdout); } catch { throw new Error('Machine owner marker unavailable'); }
    if (result.code !== 0 || marker.version !== 1 || marker.machine !== manifest.machine || marker.purpose !== purpose) throw new Error('Machine owner marker mismatch');
  }
  async function status(id) { await init(); return get(id); }
  return {
    status,
    async register(file) {
      return locked(async () => {
        const manifest = await validate(await plainFile(file));
        await owner(manifest);
        const names = (await readdir(registry)).filter(name => name.endsWith('.json'));
        if (names.length > 100) throw new Error('Registry exceeds capacity safety bound');
        for (const name of names) {
          const existing = await get(name.slice(0, -5));
          if (existing.manifest.id === manifest.id) {
            if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) throw new Error('Instance already claimed with a different manifest');
            return existing;
          }
          if (existing.manifest.machine === manifest.machine || existing.manifest.worktree === manifest.worktree) throw new Error('Machine or worktree already claimed');
        }
        if (names.length >= capacity) throw new Error('Local capacity reached; stopped instances retain claims');
        const record = { manifest, gitIdentity: gitIdentity(manifest.worktree), state: 'registered', lastExitCode: null, diagnostic: null };
        await save(record); return record;
      });
    },
    async select(id) {
      return locked(async () => {
        const record = await get(id); await owner(record.manifest);
        const path = join(registry, 'current');
        const temp = `${path}.${process.pid}.tmp`;
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(id); await handle.close(); await rename(temp, path); }
        finally { await handle.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return { id, preview: record.manifest.preview };
      });
    },
    async current() { await init(); const id = (await readFile(join(registry, 'current'), 'utf8')).trim(); statePath(id); return id; },
    async operation(id, action, args = []) {
      if (!['start', 'stop', 'resume', 'exec', 'test', 'logs'].includes(action)) throw new Error('Unknown local action');
      if (args.length > 128 || args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new Error('Invalid command arguments');
      if (['exec', 'test'].includes(action) && (!args.length || args[0].startsWith('-'))) throw new Error('Provide an executable after --');
      return locked(async () => {
        const record = await get(id); const manifest = record.manifest;
        await owner(manifest);
        let result;
        try {
          if (['start', 'stop', 'resume'].includes(action)) {
            const ordered = action === 'stop' ? [...manifest.managedUnits].reverse() : manifest.managedUnits;
            for (const unit of ordered) {
              // Recheck even between lifecycle writes: partial failures keep the claim.
              await owner(manifest);
              result = await invoke(manifest, 'root', ['systemctl', action === 'stop' ? 'stop' : 'start', unit]);
              if (result.code !== 0) break;
            }
            record.state = result.code === 0 ? action === 'stop' ? 'stopped' : 'running' : 'failed';
          } else if (action === 'logs') {
            if (args.length) throw new Error('Logs use fixed units and a finite 200-line limit');
            result = await invoke(manifest, 'root', ['journalctl', '--no-pager', '-n', '200', ...manifest.managedUnits.flatMap(unit => ['-u', unit])]);
          } else result = await invoke(manifest, 'matrix', ['--workdir', manifest.sourceRoot, ...args]);
          record.lastExitCode = result.code;
          record.diagnostic = result.code === 0 ? null : { action, code: result.code, stderr: result.stderr };
          await save(record);
          return { ...result, id, preview: manifest.preview, state: record.state };
        } catch (error) {
          record.state = 'failed'; record.diagnostic = { action, message: redact(error.message) };
          await save(record); throw error;
        }
      });
    },
  };
}
