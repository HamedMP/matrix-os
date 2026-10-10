import { createHash } from 'node:crypto';
import { glob, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Refresh inside-app fingerprints before computing the portable build stamp. */
export async function refreshUtilitiesBuildInputs(root, appDir) {
  const files = ['scripts/build-utilities-app.mjs', 'packages/utilities-runtime/package.json', 'pnpm-lock.yaml'];
  for await (const file of glob('packages/brand/src/**', { cwd: root })) {
    if (/\.(?:ts|tsx)$/.test(file)) files.push(file);
  }
  const inputs = {};
  for (const file of files.sort()) inputs[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
  const content = JSON.stringify(inputs, null, 2) + '\n';
  const path = join(appDir, 'build-inputs.json');
  let previous;
  try { previous = await readFile(path, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (previous !== content) await writeFile(path, content);
}
