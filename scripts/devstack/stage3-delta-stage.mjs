import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import { readPrivateDevStackFile, withDevStackRegistryLock } from './local.mjs';
import { identifySourceWorktree } from './source-projection.mjs';

const exec = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true });
const objectId = /^[a-f0-9]{40}$/;
const identityDigest = /^[a-f0-9]{64}$/;
const maxEntries = 1000;
const maxDeltaBytes = 4 * 1024 ** 2;
const maxBlobBytes = 32 * 1024 ** 2;
const maxTreeBytes = 16 * 1024 ** 2;
const maxTreeEntries = 50_000;
const diverged = () => new Error('The DevStack staging checkout diverged from its managed source. Inspect it before retrying.');
const needsRecovery = () => new Error('The DevStack staging checkout needs operator recovery before synchronization.');

function canonicalAbsolute(path) {
  return typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
}

function contains(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

function portableName(path) {
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

function validPath(path) {
  if (typeof path !== 'string' || path.length > 4096 || /[\\\p{Cc}\p{Cf}\p{Cs}\u2028\u2029:<>|?*"]/u.test(path)) return false;
  const parts = path.split('/');
  return parts.length <= 64 && parts.every(part => part && !/[ .]$/.test(part) && portableName(part) !== '.git');
}

function isMode(mode) {
  return mode === 0o644 || mode === 0o755;
}

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function blobId(contents) {
  return createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
}

function fingerprint(entry) {
  return entry.kind === 'delete' ? entry : {
    path: entry.path, kind: 'file', mode: entry.mode, blob: blobId(Buffer.from(entry.content, 'base64')),
  };
}

function inventory(entries) {
  if (!Array.isArray(entries) || entries.length > maxEntries) throw needsRecovery();
  const result = new Map();
  for (const entry of entries) {
    if (!validPath(entry?.path) || result.has(entry.path) || (entry.kind !== 'delete' &&
        (entry.kind !== 'file' || !isMode(entry.mode) || typeof entry.blob !== 'string' || !objectId.test(entry.blob)))) throw needsRecovery();
    result.set(entry.path, entry);
  }
  return result;
}

function ancestors(path) {
  const parents = [];
  for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1)) parents.push(path.slice(0, end));
  return parents;
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path, contents, mode) {
  const directory = dirname(path);
  const temp = join(directory, `.devstack-delta-${randomUUID()}`);
  const handle = await open(temp, 'wx', mode);
  let published = false;
  try {
    try {
      await handle.writeFile(contents);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    published = true;
    await syncDirectory(directory);
  } finally {
    if (!published) await unlink(temp);
  }
}

/** The authorized ingress validates the canonical delta before calling this
 * sole-writer staging process. The isolated runtime only mounts the mirror.
 */
export function createStage3DeltaStage({ sourceRoot, sourceIdentity, base, stateDir }) {
  if (!canonicalAbsolute(sourceRoot) || !canonicalAbsolute(stateDir) || contains(sourceRoot, stateDir) ||
      contains(stateDir, sourceRoot) || typeof sourceIdentity !== 'string' || !identityDigest.test(sourceIdentity) ||
      typeof base !== 'string' || !objectId.test(base)) throw new Error('Invalid DevStack source staging enrollment.');
  const key = createHash('sha256').update(sourceRoot).digest('hex');
  const journal = join(stateDir, `${key}.json`);
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

  async function git(...args) {
    const { stdout } = await exec('git', ['-C', sourceRoot, ...args], {
      env: { ...gitEnv, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'buffer', timeout: 30_000, maxBuffer: maxBlobBytes,
    });
    return stdout;
  }

  async function verifySource() {
    const stat = await statIfPresent(sourceRoot);
    if (!stat?.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) ||
        await realpath(sourceRoot) !== sourceRoot || await identifySourceWorktree(sourceRoot) !== sourceIdentity) {
      throw new Error('The DevStack staging checkout identity changed.');
    }
    const [head, indexed, flags] = await Promise.all([
      git('rev-parse', '--verify', 'HEAD'), git('diff-index', '--cached', '--name-only', '-z', base),
      git('ls-files', '--cached', '-v', '-z'),
    ]);
    if (head.toString('ascii').trim() !== base) throw new Error('The DevStack staging checkout base changed.');
    const indexEntries = decoder.decode(flags).split('\0').slice(0, -1);
    if (indexed.length || indexEntries.length > maxTreeEntries || indexEntries.some(entry => !entry.startsWith('H '))) throw diverged();
  }

  async function readTree() {
    const bytes = await git('ls-tree', '-rz', '-t', base);
    if (bytes.length > maxTreeBytes) throw new Error('The DevStack staging baseline is too large.');
    const entries = decoder.decode(bytes).split('\0');
    if (entries.length > maxTreeEntries + 1) throw new Error('The DevStack staging baseline is too large.');
    const tree = new Map();
    for (const row of entries.slice(0, -1)) {
      const separator = row.indexOf('\t');
      const path = row.slice(separator + 1);
      const [mode, type, blob] = row.slice(0, separator).split(' ');
      const spelling = portableName(path);
      if (tree.has(spelling)) throw new Error('The DevStack staging baseline contains ambiguous paths.');
      tree.set(spelling, { path, mode: Number.parseInt(mode, 8) & 0o777, type, blob });
    }
    return tree;
  }

  async function inspectParents(path, create = false) {
    for (const parent of ancestors(path)) {
      const full = join(sourceRoot, parent);
      const stat = await statIfPresent(full);
      if (stat && (!stat.isDirectory() || await realpath(full) !== full)) throw diverged();
      if (!stat && !create) return false;
      if (!stat) {
        await mkdir(full, { mode: 0o700 });
        await syncDirectory(dirname(full));
      }
    }
    return true;
  }

  async function verifyFile(path, expected) {
    const full = join(sourceRoot, path);
    const stat = await inspectParents(path) && await statIfPresent(full);
    if (!expected || expected.kind === 'delete') {
      if (stat) throw diverged();
      return;
    }
    if (!stat || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111) !== (expected.mode & 0o111) ||
        stat.size > maxBlobBytes) throw diverged();
    const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const contents = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(contents, 0, contents.length, 0);
      if (bytesRead !== stat.size || blobId(contents.subarray(0, bytesRead)) !== expected.blob) throw diverged();
    } finally {
      await file.close();
    }
  }

  function plan(tree, previous, next) {
    const names = new Map();
    const paths = new Set([...previous.keys(), ...next.keys()]);
    for (const path of paths) {
      for (const [name, leaf] of [...ancestors(path).map(parent => [parent, false]), [path, true]]) {
        const key = portableName(name);
        const baseEntry = tree.get(key);
        const observed = names.get(key);
        if ((observed && (observed.name !== name || observed.leaf !== leaf)) || (baseEntry && (
          baseEntry.path !== name || (leaf ? baseEntry.type !== 'blob' || !isMode(baseEntry.mode) : baseEntry.type !== 'tree')
        ))) throw new Error('The DevStack delta conflicts with a checkout path.');
        names.set(key, { name, leaf });
      }
    }
    return paths;
  }

  async function restoreOrWrite(path, desired, entry) {
    const full = join(sourceRoot, path);
    if (!desired || desired.kind === 'delete') {
      await unlink(full);
      await syncDirectory(dirname(full));
      return;
    }
    const contents = entry ? Buffer.from(entry.content, 'base64') : await git('cat-file', 'blob', desired.blob);
    await inspectParents(path, true);
    await writeAtomic(full, contents, desired.mode);
  }

  return async function stage(delta, action, { beforeWrite } = {}) {
    if (delta?.base !== base) throw new Error('The DevStack delta does not match the enrolled base.');
    if (!Array.isArray(delta.entries) || delta.entries.length > maxEntries || Buffer.byteLength(JSON.stringify(delta)) > maxDeltaBytes ||
        typeof action !== 'function') throw new Error('Invalid bounded DevStack staging request.');
    const entries = new Map();
    for (const entry of delta.entries) {
      if (!validPath(entry?.path) || entries.has(entry.path) || (entry.kind !== 'delete' && (entry.kind !== 'file' || !isMode(entry.mode) ||
          typeof entry.content !== 'string' || Buffer.from(entry.content, 'base64').toString('base64') !== entry.content))) {
        throw new Error('Invalid DevStack staging entry.');
      }
      entries.set(entry.path, entry);
    }
    const next = inventory([...entries.values()].map(fingerprint));
    return withDevStackRegistryLock(stateDir, async () => {
      await verifySource();
      const prior = await statIfPresent(journal) && await readPrivateDevStackFile(journal, maxDeltaBytes + maxEntries * 100);
      if (prior && (prior.status !== 'ready' || prior.base !== base || prior.sourceIdentity !== sourceIdentity)) throw needsRecovery();
      const previous = inventory(prior?.entries ?? []);
      const tree = await readTree();
      const paths = plan(tree, previous, next);
      const changed = decoder.decode(await git('ls-files', '--modified', '--deleted', '--others', '--deduplicate', '-z')).split('\0').slice(0, -1);
      if (changed.length > maxTreeEntries) throw diverged();
      for (const path of new Set([...paths, ...changed])) {
        const baseline = tree.get(portableName(path));
        if (baseline && (baseline.path !== path || baseline.type !== 'blob' || !isMode(baseline.mode))) throw diverged();
        if (!paths.has(path) && !baseline) throw diverged();
        await verifyFile(path, previous.get(path) ?? baseline);
      }
      const writes = [];
      for (const path of paths) {
        const baseline = tree.get(portableName(path));
        const before = previous.get(path) ?? baseline;
        const desired = next.get(path) ?? baseline;
        if (before?.blob !== desired?.blob || before?.mode !== desired?.mode) writes.push({ path, desired });
      }
      if (writes.length) {
        await beforeWrite?.();
        const save = status => writeAtomic(journal, JSON.stringify({ status, base, sourceIdentity, entries: [...next.values()] }), 0o600);
        await save('pending');
        try {
          for (const { path, desired } of writes) await restoreOrWrite(path, desired, entries.get(path));
          await save('ready');
        } catch (error) {
          throw new Error(needsRecovery().message, { cause: error });
        }
      }
      // A delta can change .gitignore or contain a force-added file. An ignored
      // addition would silently disappear from the mirror, so fail this pilot.
      const additions = [...next.values()].filter(entry => entry.kind === 'file' && !tree.has(portableName(entry.path)));
      if (additions.length) {
        const eligible = new Set(decoder.decode(await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0'));
        if (additions.some(entry => !eligible.has(entry.path))) throw new Error('The DevStack delta contains an ignored source addition.');
      }
      return action();
    }, `${key}.lock`);
  };
}
