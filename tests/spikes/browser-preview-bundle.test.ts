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
  it('stages a separate production runtime without Preview guards or optional diagnostic engines', async () => {
    const { stageBrowserRuntime } = await import('../../scripts/stage-browser-preview.mjs');
    const root = await mkdtemp(join(tmpdir(), 'browser-runtime-bundle-')); temporary.push(root);
    const source = join(root, 'source'); const bin = join(root, 'bin');
    execFileSync('cp', ['-a', 'scripts/spikes/browser-vps/.', source]);
    // A clean CI checkout has no ignored Vite dist. Build an explicit fixture
    // after copying so local build artifacts cannot overwrite the test input.
    await rm(join(source, 'lab/dist'), { recursive: true, force: true });
    await mkdir(join(source, 'lab/dist/assets'), { recursive: true });
    await writeFile(join(source, 'lab/dist/index.html'), '<!doctype html><html><head><title>Browser Lab</title></head><body>built viewer</body></html>');
    await writeFile(join(source, 'lab/dist/assets/index-fixture.js'), '/* built fixture */');
    await stageBrowserRuntime(source, bin);
    const archive = join(bin, 'matrix-browser-runtime.tar.gz');
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    const { createHash } = await import('node:crypto');
    expect((await readFile(archive + '.sha256', 'utf8')).trim()).toBe(createHash('sha256').update(await readFile(archive)).digest('hex'));
    expect((await stat(archive + '.sha256')).mode & 0o777).toBe(0o644);
    expect(files).toContain('runtime-services.json');
    expect(await readFile(join(bin, 'matrix-browser-ui-index-fixture.js'), 'utf8')).toBe('/* built fixture */');
    expect(await readFile(join(bin, 'matrix-browser-ui-index.html'), 'utf8')).toContain('matrix-browser-product');
    expect(await readFile(join(bin, 'matrix-browser-ui-index.html'), 'utf8')).toContain('<title>Browser</title>');
    expect(await readFile(join(source, 'lab/dist/index.html'), 'utf8')).toContain('<title>Browser Lab</title>');
    expect(await readFile(join(source, 'lab/dist/index.html'), 'utf8')).not.toContain('matrix-browser-product');
    expect(files).toContain('supervisor.mjs');
    expect(files).not.toMatch(/install.sh|update-experience|native-experience|matrix.json|agent_browser_runner|browser_use_runner|node_modules|chrome-profile/);
    expect((await stat(archive)).mode & 0o777).toBe(0o644);
  });
  it('ships the complete built viewer and native installer, excluding dependencies and local state', async () => {
    const { stageBrowserPreview } = await import('../../scripts/stage-browser-preview.mjs');
    const root = await mkdtemp(join(tmpdir(), 'browser-preview-bundle-')); temporary.push(root);
    const source = join(root, 'source'); const bin = join(root, 'bin');
    // Use the actual reviewed runtime files; no dependency checkout is needed by the installer.
    execFileSync('cp', ['-a', 'scripts/spikes/browser-vps/.', source]);
    await rm(join(source, 'lab/dist'), { recursive: true, force: true });
    await mkdir(join(source, 'lab/dist'), { recursive: true });
    await writeFile(join(source, 'lab/dist/index.html'), '<div>built viewer</div>');
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
