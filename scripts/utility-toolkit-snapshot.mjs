import { createHash } from 'node:crypto';
import { readFile, lstat, opendir, unlink, rmdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const ephemeralAudio = `// Audio files are deliberately kept in memory in Matrix Utilities.
/** @returns {Promise<ReturnType<typeof import("./audio-tools.mjs").normalizeAudioSessionManifest> & {files: Map<string, Blob>}>} */
export async function readAudioSession() {
  throw new Error("Files stay in the current Utilities window. Reloading closes this session.");
}
/** @param {string} id @param {Blob} file */
export async function saveAudioSessionFile(id, file) {}
/** @param {unknown} manifest */
export async function saveAudioSessionManifest(manifest) {}
/** @param {string} id */
export async function deleteAudioSessionFile(id) {}
export async function clearAudioSession() {}
`;

export function adaptToolkitSource(sourcePath, source) {
  if (sourcePath.endsWith('/audio-session.mjs')) return ephemeralAudio;
  const workspace = sourcePath.startsWith('src/app/tools/');
  return source
    .replace(/^['"]use client['"];\s*/, '')
    .replaceAll('../../lib/free-tools/', '../lib/')
    .replaceAll('@/lib/free-tools/', workspace ? '../lib/' : './')
    .replaceAll('@/components/landing/theme', '@matrix-os/brand')
    .replaceAll('@/lib/posthog-client', '../runtime/telemetry')
    .replace(/(["'])\/tools\/models\/([^"']+)\1/g, (_, quote, asset) => `new URL("./tools/models/${asset}", document.baseURI).href`);
}

const GENERATED_ROOTS = ['src/vendor', 'public/tools'];
const MAX_SNAPSHOT_FILES = 512;

/** Inspect only importer-owned trees; never traverse a symlink. */
export async function inspectGeneratedFiles(appRoot) {
  const root = resolve(appRoot), files = [], directories = [];
  let visited = 0;
  async function walk(relative, depth) {
    if (depth > 24 || ++visited > 2048) throw new Error('Toolkit tree is too large.');
    const absolute = resolve(root, relative), info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('Toolkit symlinks are unsupported.');
    if (info.isDirectory()) {
      directories.push(relative);
      for await (const entry of await opendir(absolute)) await walk(`${relative}/${entry.name}`, depth + 1);
    } else if (info.isFile()) {
      if (files.length >= MAX_SNAPSHOT_FILES) throw new Error('Toolkit tree is too large.');
      files.push(relative);
    } else throw new Error('Toolkit files must be regular files.');
  }
  for (const namespace of GENERATED_ROOTS) {
    let cursor = root, missing = false;
    for (const part of ['', ...namespace.split('/')]) {
      cursor = resolve(cursor, part);
      let info;
      try { info = await lstat(cursor); }
      catch (error) { if (error?.code === 'ENOENT') { missing = true; break; } throw error; }
      if (info.isSymbolicLink()) throw new Error('Toolkit symlinks are unsupported.');
      if (!info.isDirectory()) throw new Error('Toolkit directories must be real directories.');
    }
    if (!missing) await walk(namespace, 0);
  }
  return { files: files.sort(), directories };
}

/** Remove stale importer output, preserving every file outside generated trees. */
export async function reconcileGeneratedFiles(appRoot, expectedPaths) {
  if (!Array.isArray(expectedPaths) || expectedPaths.length > MAX_SNAPSHOT_FILES || expectedPaths.some((path) =>
    typeof path !== 'string' || path.length > 1024 || !/^[\w./-]+$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    !GENERATED_ROOTS.some((namespace) => path.startsWith(namespace + '/')))) throw new Error('Invalid toolkit paths.');
  const root = resolve(appRoot), { files, directories } = await inspectGeneratedFiles(root);
  for (const path of files) if (!expectedPaths.includes(path)) await unlink(resolve(root, path));
  for (const path of directories.reverse()) {
    try { await rmdir(resolve(root, path)); }
    catch (error) { if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error; }
  }
}

export async function verifySnapshot(appRoot, manifest) {
  const root = resolve(appRoot);
  if (!Array.isArray(manifest?.files) || manifest.files.length > MAX_SNAPSHOT_FILES) throw new Error('Invalid toolkit manifest.');
  const changed = [];
  for (const file of manifest.files) {
    const path = resolve(root, file.path);
    if (!path.startsWith(root + sep) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid toolkit manifest.');
    try {
      // All path components must be real directories/files, never external symlinks.
      let cursor = root;
      for (const part of file.path.split('/')) {
        cursor = resolve(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Toolkit symlinks are unsupported.');
      }
      if (sha256(await readFile(path)) !== file.sha256) changed.push(file.path);
    } catch (error) {
      if (error?.code === 'ENOENT') changed.push(file.path);
      else throw error;
    }
  }
  const { files } = await inspectGeneratedFiles(root);
  const expected = manifest.files.map((file) => file.path);
  for (const path of files) if (!expected.includes(path)) changed.push(path);
  return changed;
}
