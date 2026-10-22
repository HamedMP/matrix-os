import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Explicit runtime inputs: never archive a checkout, dependency store or browser profile.
const files = [
  'install.sh', 'update-experience.sh', 'native-experience.py', 'native-experience.json',
  'supervisor.mjs', 'native-windows.mjs', 'chrome-graceful-stop.mjs', 'safe-errors.mjs',
  'nginx-viewer.mjs', 'viewer-auth.mjs', 'agent_browser_runner.mjs', 'browser_use_runner.py',
  'invoices/fixture.mjs', 'invoices/original-pdf.mjs', 'lab/matrix.json', 'lab/dist',
];

export async function stageBrowserPreview(source, bin) {
  // Fail the bundle build if the diagnostic viewer was not built.
  await readFile(join(source, 'lab/dist/index.html'));
  await mkdir(bin, { recursive: true });
  await run('tar', ['-czf', join(bin, 'matrix-browser-preview.tar.gz'), '-C', source, ...files], { timeout: 60_000, maxBuffer: 4096 });
  await copyFile(join(source, 'native-experience.py'), join(bin, 'matrix-browser-preview-guard.py'));
  // Checkout umasks vary. Privileged payloads must stay read-only to the
  // preview owner after cloud-init changes their group to matrix.
  await chmod(join(bin, 'matrix-browser-preview.tar.gz'), 0o644);
  await chmod(join(bin, 'matrix-browser-preview-guard.py'), 0o644);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: stage-browser-preview.mjs <built-source> <bundle-bin>');
  await stageBrowserPreview(process.argv[2], process.argv[3]);
}
