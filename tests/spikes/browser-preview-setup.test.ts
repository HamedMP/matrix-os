import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(handle = 'pv-2722-3fa91c2e', slot = handle) {
  const root = await mkdtemp(join(tmpdir(), 'browser-preview-setup-')); temporary.push(root);
  const bin = join(root, 'opt/matrix/bin'); const mocks = join(root, 'mocks');
  for (const dir of [bin, mocks, join(root, 'opt/matrix/env'), join(root, 'run/lock'), join(root, 'payload')]) await mkdir(dir, { recursive: true });
  await writeFile(join(root, 'opt/matrix/env/host.env'), `MATRIX_HANDLE=${handle}\nMATRIX_RUNTIME_SLOT=${slot}\n`);
  const script = (await readFile('distro/customer-vps/host-bin/matrix-install-browser-preview', 'utf8'))
    .replaceAll('/opt/matrix', join(root, 'opt/matrix'))
    .replaceAll('/etc/systemd/system', join(root, 'units'))
    .replaceAll('/run/matrix-browser-preview.lock', join(root, 'run/matrix-browser-preview.lock'));
  await writeFile(join(bin, 'matrix-install-browser-preview'), script);
  // Simulate root only inside the fixture; run the real target guard against fixture metadata.
  const guard = (await readFile('scripts/spikes/browser-vps/native-experience.py', 'utf8'))
    .replace('os.getuid() != 0', 'False').replace('/opt/matrix/env/host.env', join(root, 'opt/matrix/env/host.env'));
  await writeFile(join(bin, 'matrix-browser-preview-guard.py'), guard);
  for (const [name, body] of Object.entries({ id: 'echo 0', stat: 'echo 0:0:755' })) {
    await writeFile(join(mocks, name), `#!/bin/sh\n${body}\n`); await chmod(join(mocks, name), 0o755);
  }
  for (const mode of ['install', 'update-experience']) {
    await writeFile(join(root, 'payload', `${mode}.sh`), `#!/bin/sh\nmkdir -p '${join(root, 'opt/matrix-browser-lab')}'\nprintf '${mode}:%s\\n' "$1" >> '${join(root, 'actions')}'\n`);
  }
  execFileSync('tar', ['-czf', join(bin, 'matrix-browser-preview.tar.gz'), '-C', join(root, 'payload'), '.']);
  return { root, bin, mocks, run: (target = handle) => execFileSync('bash', [join(bin, 'matrix-install-browser-preview'), target], {
    encoding: 'utf8', env: { ...process.env, PATH: `${mocks}:${process.env.PATH}` }, timeout: 10_000,
  }) };
}

describe('supported Browser preview setup command', () => {
  it('installs the packaged runtime on an exact Private Preview without a repository checkout', async () => {
    const f = await fixture(); f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe('install:pv-2722-3fa91c2e\n');
    expect(await readFile(join(f.root, 'opt/matrix-browser-lab/.setup-complete'), 'utf8')).toBe('');
  });
  it.each(['primary', 'pv-2722-aaaaaaaa'])('rejects target/slot mismatch %s before dispatch', async slot => {
    const f = await fixture('pv-2722-3fa91c2e', slot);
    expect(() => f.run()).toThrow();
    await expect(readFile(join(f.root, 'actions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('updates existing installations without reinstalling the browser or its profile', async () => {
    const f = await fixture(); const installed = join(f.root, 'opt/matrix-browser-lab');
    await mkdir(join(installed, 'app'), { recursive: true });
    await writeFile(join(installed, 'app/supervisor.mjs'), '// existing');
    await writeFile(join(installed, 'viewer.passwd'), 'fixture-only');
    await writeFile(join(installed, '.setup-complete'), '');
    f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe('update-experience:pv-2722-3fa91c2e\n');
    expect(await readFile(join(installed, 'viewer.passwd'), 'utf8')).toBe('fixture-only');
  });
  it('accepts the read-only root:matrix payload produced by fresh cloud-init', async () => {
    const f = await fixture(); await writeFile(join(f.mocks, 'stat'), '#!/bin/sh\necho 0:1000:755\n');
    f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe('install:pv-2722-3fa91c2e\n');
  });
  it('retries first-install steps when only supervisor and credentials survived a failure', async () => {
    const f = await fixture(); const installed = join(f.root, 'opt/matrix-browser-lab');
    await mkdir(join(installed, 'app'), { recursive: true });
    await writeFile(join(installed, 'app/supervisor.mjs'), '// partial install');
    await writeFile(join(installed, 'viewer.passwd'), 'fixture-only');
    f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe('install:pv-2722-3fa91c2e\n');
    expect(await readFile(join(installed, 'viewer.passwd'), 'utf8')).toBe('fixture-only');
  });
  it('recognizes a fully running legacy installation without a completion marker', async () => {
    const f = await fixture(); const installed = join(f.root, 'opt/matrix-browser-lab');
    await mkdir(join(installed, 'app'), { recursive: true }); await mkdir(join(f.root, 'units'));
    await writeFile(join(installed, 'app/supervisor.mjs'), '// legacy');
    await writeFile(join(installed, 'viewer.passwd'), 'fixture-only');
    await writeFile(join(f.root, 'opt/matrix/env/host.env'), 'MATRIX_HANDLE=pv-2722-3fa91c2e\nMATRIX_RUNTIME_SLOT=pv-2722-3fa91c2e\nMATRIX_BROWSER_LAB=true\n');
    await writeFile(join(f.mocks, 'systemctl'), '#!/bin/sh\nexit 0\n'); await chmod(join(f.mocks, 'systemctl'), 0o755);
    for (const unit of ['vnc', 'wm', 'desktop', 'panel', 'chrome', '']) {
      await writeFile(join(f.root, 'units', `matrix-browser-lab${unit ? `-${unit}` : ''}.service`), '// legacy unit');
    }
    f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe('update-experience:pv-2722-3fa91c2e\n');
  });
  it('refuses a symlinked installation archive', async () => {
    const f = await fixture(); const archive = join(f.bin, 'matrix-browser-preview.tar.gz');
    await rm(archive); await symlink(join(f.root, 'elsewhere'), archive);
    expect(() => f.run()).toThrow();
    await expect(readFile(join(f.root, 'actions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses an unprivileged invocation', async () => {
    const f = await fixture(); await writeFile(join(f.mocks, 'id'), '#!/bin/sh\necho 1000\n');
    expect(() => f.run()).toThrow();
    await expect(readFile(join(f.root, 'actions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses owner-writable installation code', async () => {
    const f = await fixture(); await writeFile(join(f.mocks, 'stat'), '#!/bin/sh\necho 0:0:777\n');
    expect(() => f.run()).toThrow();
    await expect(readFile(join(f.root, 'actions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
