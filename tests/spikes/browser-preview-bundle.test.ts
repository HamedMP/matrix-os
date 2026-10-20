import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('Browser preview installation payload', () => {
  it('fails the bundle build when the viewer is absent', async () => {
    const { stageBrowserPreview } = await import('../../scripts/stage-browser-preview.mjs');
    const root = await mkdtemp(join(tmpdir(), 'browser-preview-unbuilt-')); temporary.push(root);
    await expect(stageBrowserPreview(root, join(root, 'bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('ships the complete built viewer and native installer, excluding dependencies and local state', async () => {
    const { stageBrowserPreview } = await import('../../scripts/stage-browser-preview.mjs');
    const root = await mkdtemp(join(tmpdir(), 'browser-preview-bundle-')); temporary.push(root);
    const source = join(root, 'source'); const bin = join(root, 'bin');
    await mkdir(join(source, 'lab/dist'), { recursive: true });
    await writeFile(join(source, 'lab/dist/index.html'), '<div>built viewer</div>');
    // Use the actual reviewed runtime files; no dependency checkout is needed by the installer.
    execFileSync('cp', ['-a', 'scripts/spikes/browser-vps/.', source]);
    await mkdir(join(source, 'node_modules'), { recursive: true });
    await writeFile(join(source, 'node_modules/private'), 'must not ship');
    await mkdir(join(source, '.venv'), { recursive: true });
    await writeFile(join(source, '.venv/private'), 'must not ship');
    await chmod(join(source, 'native-experience.py'), 0o775);
    await stageBrowserPreview(source, bin);
    const archive = join(bin, 'matrix-browser-preview.tar.gz');
    const unpacked = join(root, 'unpacked'); await mkdir(unpacked);
    execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
    for (const file of ['install.sh', 'update-experience.sh', 'supervisor.mjs', 'viewer-auth.mjs',
      'native-experience.py', 'native-experience.json', 'native-windows.mjs', 'chrome-graceful-stop.mjs',
      'safe-errors.mjs', 'browser_use_runner.py', 'agent_browser_runner.mjs', 'invoices/fixture.mjs',
      'invoices/original-pdf.mjs', 'lab/matrix.json', 'lab/dist/index.html']) {
      expect(await readFile(join(unpacked, file), 'utf8'), file).not.toHaveLength(0);
    }
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    expect(files).not.toMatch(/node_modules|\.venv|lab\/src|codex-mcp|__pycache__/);
    expect(await readFile(join(bin, 'matrix-browser-preview-guard.py'), 'utf8')).toBe(await readFile(join(source, 'native-experience.py'), 'utf8'));
    expect((await stat(join(bin, 'matrix-browser-preview-guard.py'))).mode & 0o777).toBe(0o644);
    expect((await stat(archive)).mode & 0o777).toBe(0o644);
  });
});
