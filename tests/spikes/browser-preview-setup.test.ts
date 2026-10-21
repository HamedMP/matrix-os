import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const privateHandle = 'pv-2722-3fa91c2e';
const machineId = '12345678-1234-4123-8123-123456789abc';
const ownerId = 'user_syntheticOwner';
const privateArguments = [privateHandle, machineId, ownerId];
const identity = `MATRIX_MACHINE_ID=${machineId}\nMATRIX_CLERK_USER_ID=${ownerId}\nMATRIX_USER_ID=${ownerId}\n`;
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(handle = privateHandle, slot = handle) {
  const root = await mkdtemp(join(tmpdir(), 'browser-preview-setup-')); temporary.push(root);
  const bin = join(root, 'opt/matrix/bin'); const mocks = join(root, 'mocks');
  for (const dir of [bin, mocks, join(root, 'opt/matrix/env'), join(root, 'run/lock'), join(root, 'payload')]) await mkdir(dir, { recursive: true });
  await writeFile(join(root, 'opt/matrix/env/host.env'), `MATRIX_HANDLE=${handle}\nMATRIX_RUNTIME_SLOT=${slot}\n${identity}`);
  const script = (await readFile('distro/customer-vps/host-bin/matrix-install-browser-preview', 'utf8'))
    .replaceAll('/opt/matrix', join(root, 'opt/matrix'))
    .replaceAll('/etc/systemd/system', join(root, 'units'))
    .replaceAll('/run/matrix-browser-preview.lock', join(root, 'run/matrix-browser-preview.lock'))
    .replaceAll('/tmp/matrix-browser-preview.', join(root, 'matrix-browser-preview.'));
  await writeFile(join(bin, 'matrix-install-browser-preview'), script);
  // Simulate root only inside the fixture; run the real target guard against fixture metadata.
  const guard = (await readFile('scripts/spikes/browser-vps/native-experience.py', 'utf8'))
    .replace('os.getuid() != 0', 'False').replace('/opt/matrix/env/host.env', join(root, 'opt/matrix/env/host.env'));
  await writeFile(join(bin, 'matrix-browser-preview-guard.py'), guard);
  for (const [name, body] of Object.entries({ id: 'echo 0', stat: 'echo 0:0:755' })) {
    await writeFile(join(mocks, name), `#!/bin/sh\n${body}\n`); await chmod(join(mocks, name), 0o755);
  }
  await writeFile(join(mocks, 'mktemp'), `#!/bin/sh\necho called >> '${join(root, 'temporary-actions')}'\nexec /usr/bin/mktemp "$@"\n`);
  await chmod(join(mocks, 'mktemp'), 0o755);
  for (const mode of ['install', 'update-experience']) {
    await writeFile(join(root, 'payload', `${mode}.sh`), `#!/bin/sh\nmkdir -p '${join(root, 'opt/matrix-browser-lab')}'\nprintf '${mode}:%s\\n' "$*" >> '${join(root, 'actions')}'\n`);
  }
  execFileSync('tar', ['-czf', join(bin, 'matrix-browser-preview.tar.gz'), '-C', join(root, 'payload'), '.']);
  return { root, bin, mocks, run: (args = handle.startsWith('pv-') ? [handle, machineId, ownerId] : [handle]) => execFileSync('bash', [join(bin, 'matrix-install-browser-preview'), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${mocks}:${process.env.PATH}` }, timeout: 10_000,
  }) };
}

describe('supported Browser preview setup command', () => {
  it('installs the packaged runtime on an exact Private Preview without a repository checkout', async () => {
    const f = await fixture(); f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe(`install:${privateArguments.join(' ')}\n`);
    expect(await readFile(join(f.root, 'opt/matrix-browser-lab/.setup-complete'), 'utf8')).toBe('');
  });
  it('keeps the legacy exact pr-* one-argument setup compatible', async () => {
    const f = await fixture('pr-2722'); f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe('install:pr-2722\n');
  });
  it.each<[string, string[], string]>([
    ['missing arguments', [privateHandle], ''],
    ['partial arguments', [privateHandle, machineId], ''],
    ['wrong handle', ['pv-2722-aaaaaaaa', machineId, ownerId], ''],
    ['duplicate handle', privateArguments, `MATRIX_HANDLE=${privateHandle}\n`],
    ['duplicate slot', privateArguments, `MATRIX_RUNTIME_SLOT=${privateHandle}\n`],
    ['wrong machine', [privateHandle, '22345678-1234-4123-8123-123456789abc', ownerId], ''],
    ['wrong owner', [privateHandle, machineId, 'user_other'], ''],
    ['missing machine metadata', privateArguments, 'remove:MATRIX_MACHINE_ID'],
    ['missing owner metadata', privateArguments, 'remove:MATRIX_CLERK_USER_ID'],
    ['duplicate machine', privateArguments, `MATRIX_MACHINE_ID=${machineId}\n`],
    ['duplicate owner', privateArguments, `MATRIX_CLERK_USER_ID=${ownerId}\n`],
    ['wrong owner projection', privateArguments, 'replace:MATRIX_USER_ID'],
    ['duplicate owner projection', privateArguments, `MATRIX_USER_ID=${ownerId}\n`],
  ])('rejects %s before locking, temporary files or installer dispatch', async (_name, args, mutation) => {
    const f = await fixture();
    const environment = join(f.root, 'opt/matrix/env/host.env');
    const initial = await readFile(environment, 'utf8');
    const changed = mutation.startsWith('remove:')
      ? initial.split('\n').filter(line => !line.startsWith(`${mutation.slice(7)}=`)).join('\n')
      : mutation.startsWith('replace:')
        ? initial.replace(`MATRIX_USER_ID=${ownerId}`, 'MATRIX_USER_ID=user_other')
        : initial + mutation;
    await writeFile(environment, changed);
    expect(() => f.run(args)).toThrow();
    for (const path of ['actions', 'temporary-actions', 'run/matrix-browser-preview.lock', 'opt/matrix-browser-lab/.setup-complete']) {
      await expect(readFile(join(f.root, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
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
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe(`update-experience:${privateArguments.join(' ')}\n`);
    expect(await readFile(join(installed, 'viewer.passwd'), 'utf8')).toBe('fixture-only');
  });
  it('accepts the read-only root:matrix payload produced by fresh cloud-init', async () => {
    const f = await fixture(); await writeFile(join(f.mocks, 'stat'), '#!/bin/sh\necho 0:1000:755\n');
    f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe(`install:${privateArguments.join(' ')}\n`);
  });
  it('retries first-install steps when only supervisor and credentials survived a failure', async () => {
    const f = await fixture(); const installed = join(f.root, 'opt/matrix-browser-lab');
    await mkdir(join(installed, 'app'), { recursive: true });
    await writeFile(join(installed, 'app/supervisor.mjs'), '// partial install');
    await writeFile(join(installed, 'viewer.passwd'), 'fixture-only');
    f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe(`install:${privateArguments.join(' ')}\n`);
    expect(await readFile(join(installed, 'viewer.passwd'), 'utf8')).toBe('fixture-only');
  });
  it('recognizes a fully running legacy installation without a completion marker', async () => {
    const f = await fixture(); const installed = join(f.root, 'opt/matrix-browser-lab');
    await mkdir(join(installed, 'app'), { recursive: true }); await mkdir(join(f.root, 'units'));
    await writeFile(join(installed, 'app/supervisor.mjs'), '// legacy');
    await writeFile(join(installed, 'viewer.passwd'), 'fixture-only');
    await writeFile(join(f.root, 'opt/matrix/env/host.env'), `MATRIX_HANDLE=${privateHandle}\nMATRIX_RUNTIME_SLOT=${privateHandle}\n${identity}MATRIX_BROWSER_LAB=true\n`);
    await writeFile(join(f.mocks, 'systemctl'), '#!/bin/sh\nexit 0\n'); await chmod(join(f.mocks, 'systemctl'), 0o755);
    for (const unit of ['vnc', 'wm', 'desktop', 'panel', 'chrome', '']) {
      await writeFile(join(f.root, 'units', `matrix-browser-lab${unit ? `-${unit}` : ''}.service`), '// legacy unit');
    }
    f.run();
    expect(await readFile(join(f.root, 'actions'), 'utf8')).toBe(`update-experience:${privateArguments.join(' ')}\n`);
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
