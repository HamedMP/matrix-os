import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
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

export async function verifySnapshot(appRoot, manifest) {
  const root = resolve(appRoot);
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
  return changed;
}
