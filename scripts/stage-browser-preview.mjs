import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

// Production reuses reviewed runtime modules, never Preview installer/guard entrypoints.
export async function stageBrowserRuntime(source, bin) {
  await readFile(join(source, 'lab/dist/index.html'));
  await mkdir(bin, { recursive: true });
  // The canonical setup UI must load before optional native installation.
  // Preview keeps its diagnostic default; production always opens Browser.
  // Host-bin installation and rollback operate on flat regular files. Keep UI
  // bytes in that transaction rather than silently omitting a nested directory.
  const html = (await readFile(join(source, 'lab/dist/index.html'), 'utf8')).replace(/<title>[^<]*<\/title>/i, '<title>Browser</title>');
  const marker = '<meta name="matrix-browser-product" content="browser">';
  await writeFile(join(bin, 'matrix-browser-ui-index.html'), html.includes('<head>') ? html.replace('<head>', '<head>' + marker) : marker + html, { mode: 0o644 });
  for (const asset of await readdir(join(source, 'lab/dist/assets'), { withFileTypes: true })) {
    if (!asset.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,103}$/.test(asset.name)) throw new Error('Unexpected Browser UI asset');
    await copyFile(join(source, 'lab/dist/assets', asset.name), join(bin, `matrix-browser-ui-${asset.name}`));
    await chmod(join(bin, `matrix-browser-ui-${asset.name}`), 0o644);
  }
  const runtime = files.filter(file => !['install.sh', 'update-experience.sh',
    'native-experience.py', 'native-experience.json', 'nginx-viewer.mjs', 'viewer-auth.mjs', 'lab/matrix.json', 'agent_browser_runner.mjs', 'browser_use_runner.py'].includes(file));
  await run('tar', ['-czf', join(bin, 'matrix-browser-runtime.tar.gz'), '-C', source,
    ...runtime, 'runtime-services.json'], { timeout: 60_000, maxBuffer: 4096 });
  await chmod(join(bin, 'matrix-browser-runtime.tar.gz'), 0o644);
  const checksum = createHash('sha256').update(await readFile(join(bin, 'matrix-browser-runtime.tar.gz'))).digest('hex');
  await writeFile(join(bin, 'matrix-browser-runtime.tar.gz.sha256'), checksum + '\n', { mode: 0o644 });
  await chmod(join(bin, 'matrix-browser-runtime.tar.gz.sha256'), 0o644);
}

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
  await stageBrowserRuntime(process.argv[2], process.argv[3]);
}
