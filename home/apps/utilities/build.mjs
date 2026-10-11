import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Bundled apps use the exact dependencies shipped with the Matrix host release.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const release = process.env.MATRIX_RUNTIME_ROOT ?? '/opt/matrix/app';
const script = [repository, release].map((root) => resolve(root, 'scripts/build-utilities-app.mjs')).find(existsSync);
if (!script) throw new Error('Utilities builds require the Matrix release runtime. Set MATRIX_RUNTIME_ROOT for a local source checkout.');
process.env.MATRIX_UTILITIES_APP_DIR = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(script).href);
