#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adaptToolkitSource, sha256, verifySnapshot, inspectGeneratedFiles, reconcileGeneratedFiles } from './utility-toolkit-snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(root, 'home/apps/utilities');
const manifestPath = join(appRoot, 'toolkit-source.json');
const launcherIconPath = join(root, 'home/system/icons/utilities.svg');
async function launcherArtwork() {
  const { toolIconSvg } = await import(pathToFileURL(join(appRoot, 'src/vendor/lib/tool-icons.mjs')).href);
  return toolIconSvg('utilities') + '\n';
}
if (process.argv[2] === '--verify') {
  const changed = await verifySnapshot(appRoot, JSON.parse(await readFile(manifestPath, 'utf8')));
  if (changed.length) throw new Error(`Toolkit snapshot changed: ${changed.join(', ')}`);
  if (await readFile(launcherIconPath, 'utf8') !== await launcherArtwork()) throw new Error('Utilities launcher artwork differs from the pinned toolkit.');
  console.log('Utilities toolkit snapshot verified.');
} else {
  const siteRoot = resolve(process.argv[2] ?? '../matrix-os-site');
  const git = (...args) => execFileSync('git', ['-C', siteRoot, ...args], { encoding: 'utf8' }).trim();
  const revision = git('rev-parse', 'HEAD');
  const dirty = Boolean(git('status', '--porcelain', '--', 'src/lib/free-tools', 'src/app/tools', 'public/tools'));
  if (dirty && !process.argv.includes('--allow-dirty')) throw new Error('Commit the canonical website toolkit before snapshotting it.');
  await inspectGeneratedFiles(appRoot);
  const files = [];
  async function copy(source, target, text) {
    const absolute = join(siteRoot, source);
    if (!(await lstat(absolute)).isFile()) throw new Error(`Expected regular source file: ${source}`);
    const bytes = await readFile(absolute);
    const output = text ? Buffer.from(adaptToolkitSource(source, bytes.toString('utf8'))) : bytes;
    await mkdir(dirname(join(appRoot, target)), { recursive: true });
    await writeFile(join(appRoot, target), output);
    files.push({ path: target, source, sourceSha256: sha256(bytes), sha256: sha256(output) });
  }
  for (const name of (await readdir(join(siteRoot, 'src/lib/free-tools'))).sort()) {
    if (name.endsWith('.mjs')) await copy(`src/lib/free-tools/${name}`, `src/vendor/lib/${name}`, true);
  }
  for (const name of (await readdir(join(siteRoot, 'src/app/tools'))).sort()) {
    if (/^(?:\w+Workspace|PdfRedactionPreview)\.tsx$/.test(name)) await copy(`src/app/tools/${name}`, `src/vendor/workspaces/${name}`, true);
  }
  // Model and worker-dependent tools are website-only in the installed app.
  // Keep their engines pinned, but do not ship the website's unused model assets.
  const telemetryPath = 'src/vendor/runtime/telemetry.ts';
  const telemetry = '// Utilities never sends tool inputs, outputs, or activity to website analytics.\nexport function capturePostHogEvent(..._args: unknown[]) {}\n';
  await mkdir(dirname(join(appRoot, telemetryPath)), { recursive: true });
  await writeFile(join(appRoot, telemetryPath), telemetry);
  files.push({ path: telemetryPath, sha256: sha256(telemetry) });
  await reconcileGeneratedFiles(appRoot, files.map((file) => file.path));
  await mkdir(dirname(launcherIconPath), { recursive: true });
  await writeFile(launcherIconPath, await launcherArtwork());
  await writeFile(manifestPath, JSON.stringify({ repository: 'FinnaAI/matrix-os-site', revision, dirty, adaptations: ['relative imports and app assets', 'no website analytics', 'ephemeral audio session'], files }, null, 2) + '\n');
  console.log(`Snapshotted ${files.length} toolkit files at ${revision}${dirty ? ' (development)' : ''}.`);
}
