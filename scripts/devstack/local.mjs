import { statSync, realpathSync, constants } from 'node:fs';
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
function sanitize(value = '') {
  return String(value).replace(/("[^"]*(?:token|secret|password|api[_-]?key)[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted]"').replace(/\b(?:bearer)\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b([\w-]*(?:token|secret|password|api[_-]?key)[\w-]*\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xoxb|xoxp)[-_][A-Za-z0-9_-]+/g, '[redacted]');
}
export function redact(value = '') { return sanitize(value).slice(0, 32768); }
export function commandRunner(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', env: { ...process.env, ORBENV: '' } });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.error ? `Command failed: ${result.error.code}` : result.stderr ?? '' };
}
const recordLimit = 65536;
const manifestLimit = 16384;
function serializedBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function boundedText(value, limit = 8192, tail = false) {
  const text = String(value); let low = 0, high = text.length;
  const portion = length => tail ? text.slice(text.length - length) : text.slice(0, length);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (serializedBytes(portion(mid)) <= limit) low = mid; else high = mid - 1;
  }
  const result = portion(low);
  // A suffix must not begin midway through a UTF-16 surrogate pair.
  return tail && /[\uDC00-\uDFFF]/.test(result[0] ?? '') ? result.slice(1) : result;
}
async function plainFile(path, limit = recordLimit) {
  if (!isAbsolute(path)) throw new Error('File path must be absolute');
  if (await realpath(path) !== path) throw new Error('Canonical paths required; symlink paths are not accepted');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) throw new Error('File must be owned and private 0600');
    if (stat.size > limit) throw new Error('Invalid bounded manifest/record file');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new Error('File grew beyond byte limit');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}
function gitIdentity(worktree) {
  const path = realpathSync(runCommandSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { capture: true }));
  const stat = statSync(path);
  return JSON.stringify({ path, dev: stat.dev, ino: stat.ino });
}
function previewEndpoint(value) {
  const url = new URL(value);
  // The Platform explicit slot parser sends both slot-root spellings to "/".
  // Preserve trailing slashes on resources beneath that root.
  if (/^\/vm\/[a-z0-9][a-z0-9-]{1,62}\/~runtime\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/$/.test(url.pathname)) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.href;
}

async function validate(manifest) {
  const keys = ['version', 'id', 'worktree', 'machine', 'preview', 'sourceRoot', 'managedUnits', 'sourceSHA', 'appliedRevision', 'capabilities'];
  if (!manifest || typeof manifest !== 'object' || Object.keys(manifest).some(key => !keys.includes(key))) throw new Error('Invalid local manifest fields');
  if (manifest.version !== 1 || typeof manifest.id !== 'string' || !slug.test(manifest.id) || !/^devstack-[a-z0-9][a-z0-9-]{0,54}$/.test(manifest.machine)
    || manifest.sourceRoot !== '/opt/matrix/app' || ![units, [...units, shellUnit]].some(allowed => JSON.stringify(manifest.managedUnits) === JSON.stringify(allowed))
    || !revision.test(manifest.sourceSHA) || !revision.test(manifest.appliedRevision)
    || !manifest.capabilities || Object.keys(manifest.capabilities).some(key => key !== 'sourceSync') || !['unknown', 'external-one-way'].includes(manifest.capabilities.sourceSync)) throw new Error('Invalid local manifest');
  if (serializedBytes(manifest) > manifestLimit) throw new Error('Manifest exceeds serialized byte budget');
  const url = new URL(manifest.preview);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Invalid HTTPS preview');
  if (typeof manifest.worktree !== 'string' || !isAbsolute(manifest.worktree) || await realpath(manifest.worktree) !== manifest.worktree) throw new Error('Worktree must be canonical, absolute and not a symlink');
  const top = runCommandSync('git', ['-C', manifest.worktree, 'rev-parse', '--show-toplevel'], { capture: true });
  if (await realpath(top) !== manifest.worktree) throw new Error('Pinned Git worktree mismatch');
  return manifest;
}

export function createAdapter({ registry = process.env.DEVSTACK_STATE_DIR ?? join(homedir(), '.matrixos', 'devstack'), capacity = Number(process.env.DEVSTACK_CAPACITY ?? 3), runner = commandRunner } = {}) {
  if (typeof registry !== 'string' || !isAbsolute(registry)) throw new Error('Registry path must be absolute');
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw new Error('Invalid local capacity');
  async function init() {
    await mkdir(registry, { recursive: true, mode: 0o700 });
    if (await realpath(registry) !== resolve(registry)) throw new Error('Registry symlinks are not accepted');
    const stat = await lstat(registry);
    if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Registry must be owned and private (0700)');
  }
  async function locked(action, name = '.lock') {
    await init();
    const path = join(registry, name);
    let lock; const deadline = Date.now() + 2000;
    while (!lock) {
      try { lock = await open(path, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (name !== '.lock' || Date.now() >= deadline) throw new Error(`Registry locked (${name}); inspect the owner process before removing a stale lock`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
    finally { await lock.close(); await unlink(path); }
  }
  function statePath(id) { if (typeof id !== 'string' || !slug.test(id)) throw new Error('Invalid instance id'); return join(registry, `${id}.json`); }
  async function claim(id) {
    const record = await plainFile(statePath(id));
    if (record?.manifest?.id !== id || typeof record.manifest.worktree !== 'string' || typeof record.manifest.machine !== 'string'
      || !['registered', 'starting', 'running', 'stopping', 'stopped', 'failed'].includes(record.state)
      || (record.activeLease !== undefined && typeof record.activeLease !== 'boolean')) throw new Error('Invalid retained claim');
    return record;
  }
  async function get(id) { const record = await claim(id); await validate(record.manifest); if (record.gitIdentity !== gitIdentity(record.manifest.worktree)) throw new Error('Pinned Git worktree identity changed'); return record; }
  async function save(record) {
    const content = JSON.stringify(record);
    if (Buffer.byteLength(content, 'utf8') > recordLimit) throw new Error('Record exceeds serialized byte budget');
    const path = statePath(record.manifest.id);
    const temp = `${path}.${process.pid}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.close(); await rename(temp, path); }
    finally { await handle.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function invoke(manifest, user, args, { recentStdout = false } = {}) {
    const result = await runner('orb', ['-m', manifest.machine, '-u', user, ...args]);
    return { code: Number.isInteger(result.code) ? result.code : 1, stdout: recentStdout ? boundedText(sanitize(result.stdout), 8192, true) : boundedText(redact(result.stdout)), stderr: boundedText(redact(result.stderr)) };
  }
  async function authoritativeOutput(manifest, args) {
    const result = await runner('orb', ['-m', manifest.machine, '-u', 'root', ...args]);
    const stdout = String(result.stdout ?? '');
    if (Buffer.byteLength(stdout, 'utf8') > manifestLimit) throw new Error('Machine ownership output exceeds byte limit');
    // Identity comparisons must use original bytes, never display sanitization.
    return { code: result.code, stdout };
  }
  async function owner(manifest) {
    await validate(manifest);
    const protection = await authoritativeOutput(manifest, ['stat', '--format=%u:%a:%F', '--', '/opt/matrix/.devstack-owner']);
    const [uid, mode, type] = protection.stdout.trim().split(':');
    if (protection.code !== 0 || uid !== '0' || !/^[0-7]{3,4}$/.test(mode) || (Number.parseInt(mode, 8) & 0o022) || type !== 'regular file') throw new Error('Machine owner marker is not protected');
    const result = await authoritativeOutput(manifest, ['cat', '/opt/matrix/.devstack-owner']);
    let marker;
    try { marker = JSON.parse(result.stdout); } catch { throw new Error('Machine owner marker unavailable'); }
    if (result.code !== 0 || marker.version !== 1 || marker.machine !== manifest.machine || marker.purpose !== purpose || marker.id !== manifest.id || marker.worktree !== manifest.worktree) throw new Error('Machine owner marker mismatch');
  }
  async function preflight(file) {
    const manifest = await validate(await plainFile(file, manifestLimit));
    await owner(manifest);
    for (const unit of manifest.managedUnits) {
      const result = await invoke(manifest, 'root', ['systemctl', 'show', '--property=LoadState', '--value', unit]);
      if (result.code !== 0 || result.stdout.trim() !== 'loaded') throw new Error(`Required owned unit unavailable: ${unit}`);
    }
    return { manifest, prerequisites: 'verified', readiness: 'unknown' };
  }
  async function lifecycle(manifest, action, priorLease) {
    const initial = new Map(); const attempted = []; const rollback = [];
    let result = { code: 0, stdout: '', stderr: '' }, unit;
    try {
      if (action !== 'stop') {
        for (const item of manifest.managedUnits) {
          const state = await invoke(manifest, 'root', ['systemctl', 'show', '--property=ActiveState', '--value', item]);
          if (state.code !== 0 || !['active', 'inactive', 'failed'].includes(state.stdout.trim())) throw new Error(`Cannot safely determine initial unit activity: ${item}`);
          initial.set(item, state.stdout.trim());
        }
      }
      const ordered = action === 'stop' ? [...manifest.managedUnits].reverse() : manifest.managedUnits;
      for (unit of ordered) {
        if (action !== 'stop' && initial.get(unit) === 'active') continue;
        await owner(manifest);
        if (action !== 'stop') attempted.push(unit);
        result = await invoke(manifest, 'root', ['systemctl', action === 'stop' ? 'stop' : 'start', unit]);
        if (result.code !== 0) break;
      }
    } catch (error) { result = { code: 1, stdout: '', stderr: boundedText(redact(error.message)) }; }
    if (result.code !== 0 && action !== 'stop') {
      // Includes the failed unit: systemctl may fail after partially activating it.
      for (const item of attempted.reverse()) {
        try {
          await owner(manifest);
          const stopped = await invoke(manifest, 'root', ['systemctl', 'stop', item]);
          rollback.push({ unit: item, code: stopped.code });
        } catch (error) { rollback.push({ unit: item, code: 1, message: boundedText(redact(error.message), 1024) }); }
      }
    }
    const fullyRolledBack = initial.size === manifest.managedUnits.length
      && [...initial.values()].every(state => state !== 'active') && rollback.every(item => item.code === 0) && rollback.length === attempted.length;
    const activeLease = action === 'stop' ? result.code !== 0 && priorLease : result.code === 0 || !fullyRolledBack;
    return { result, activeLease, diagnostic: result.code === 0 ? null : { action, unit, code: result.code, stderr: result.stderr, rollback } };
  }
  function hasActiveLease(record) {
    if (typeof record.activeLease === 'boolean') return record.activeLease;
    // Old running/uncertain records stay counted until an explicit lifecycle result.
    return ['running', 'starting', 'stopping', 'failed'].includes(record.state);
  }
  async function reserve(record, action) {
    await locked(async () => {
      if (action !== 'stop' && !hasActiveLease(record)) {
        const names = (await readdir(registry)).filter(name => name.endsWith('.json'));
        if (names.length > 100) throw new Error('Registry exceeds safety bound');
        let active = 0;
        for (const name of names) if (hasActiveLease(await claim(name.slice(0, -5)))) active++;
        if (active >= capacity) throw new Error('Local active capacity reached; stop an active instance before starting another');
      }
      record.activeLease = action === 'stop' ? hasActiveLease(record) : true;
      record.state = action === 'stop' ? 'stopping' : 'starting';
      await save(record);
    });
  }
  async function status(id) { await init(); return get(id); }
  return {
    status, preflight,
    async register(file) {
      const { manifest } = await preflight(file);
      return locked(async () => {
        const identity = gitIdentity(manifest.worktree);
        let existing;
        try { existing = await claim(manifest.id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!existing) {
          // New claims cannot conceal already live resources outside admission.
          for (const unit of manifest.managedUnits) {
            const state = await invoke(manifest, 'root', ['systemctl', 'show', '--property=ActiveState', '--value', unit]);
            if (state.code !== 0 || state.stdout.trim() !== 'inactive') throw new Error(`First adoption requires stopped units; stop ${unit} before registering`);
          }
        }
        return locked(async () => {
          const names = (await readdir(registry)).filter(name => name.endsWith('.json'));
          if (names.length > 100) throw new Error('Registry exceeds capacity safety bound');
          for (const name of names) {
            const existing = await claim(name.slice(0, -5));
            if (existing.manifest.id === manifest.id) {
              if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) throw new Error('Instance already claimed with a different manifest');
              if (existing.gitIdentity !== identity) throw new Error('Pinned Git worktree identity changed');
              return existing;
            }
            if (previewEndpoint(existing.manifest.preview) === previewEndpoint(manifest.preview)) throw new Error('Preview endpoint already claimed');
            if (existing.manifest.machine === manifest.machine || existing.manifest.worktree === manifest.worktree) throw new Error('Machine or worktree already claimed');
          }
          if (names.length >= 100) throw new Error('Retained registration safety bound reached');
          const record = { manifest, gitIdentity: identity, state: 'registered', activeLease: false, lastExitCode: null, diagnostic: null };
          await save(record); return record;
        });
      }, `.${manifest.id}.lock`);
    },
    async select(id) {
      const record = await get(id); await owner(record.manifest);
      return locked(async () => {
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
      statePath(id);
      return locked(async () => {
        const record = await get(id); const manifest = record.manifest;
        await owner(manifest);
        let result;
        try {
          if (['start', 'stop', 'resume'].includes(action)) {
            const priorLease = hasActiveLease(record);
            await reserve(record, action);
            const outcome = await lifecycle(manifest, action, priorLease); result = outcome.result;
            record.activeLease = outcome.activeLease;
            record.state = result.code === 0 ? action === 'stop' ? 'stopped' : 'running' : 'failed';
            record.lastExitCode = result.code; record.diagnostic = outcome.diagnostic;
            await save(record);
          } else if (action === 'logs') {
            if (args.length) throw new Error('Logs use fixed units and a finite 200-line limit');
            result = await invoke(manifest, 'root', ['journalctl', '--no-pager', '-n', '200', ...manifest.managedUnits.flatMap(unit => ['-u', unit])], { recentStdout: true });
          } else {
            result = await invoke(manifest, 'matrix', ['--workdir', manifest.sourceRoot, ...args]);
            record.lastCommand = { action, code: result.code, stderr: result.stderr };
            // Preserve lifecycle evidence; command feedback has its own field.
            if (!record.diagnostic) record.lastExitCode = result.code;
            await save(record);
          }
          return { ...result, id, preview: manifest.preview, state: record.state };
        } catch (error) {
          if (action !== 'logs') {
            record.lastCommand = { action, code: 1, message: boundedText(redact(error.message)) };
            await save(record);
          }
          throw error;
        }
      }, `.${id}.lock`);
    },
  };
}
