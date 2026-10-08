import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const sourcePath = 'distro/customer-vps/host-bin/matrix-prepare-host-prerequisites';
const names = ['bots', 'agent-workspaces', 'projects', 'worktrees'];
const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(account: boolean | 'lookup-error' = true) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'matrix-prereq-roots-'));
  cleanup.push(root);
  const home = join(root, 'home/matrix/home');
  const bin = join(root, 'test-bin');
  const marker = join(root, 'opt/matrix/HOST_PREREQUISITES_READY');
  await mkdir(home, { recursive: true });
  await mkdir(bin);
  await mkdir(join(root, 'opt/matrix'), { recursive: true });
  await writeFile(marker, 'version=1\n');
  for (const command of ['add-apt-repository', 'apparmor_parser', 'aws', 'bwrap', 'cmatrix', 'curl', 'docker',
    'elixir', 'erl', 'file', 'git', 'nginx', 'openssl', 'psql', 'socat', 'sudo', 'unzip', 'zsh', 'crypto-present']) {
    await writeFile(join(bin, command), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, command), 0o755);
  }
  await writeFile(join(bin, 'getent'), `#!/bin/sh\n${account === 'lookup-error' ? 'exit 1' : account ? `printf 'matrix:x:${process.getuid!()}:${process.getgid!()}:Matrix:/home/matrix:/bin/bash\\n'` : 'exit 2'}\n`);
  await chmod(join(bin, 'getent'), 0o755);
  // Replace only the unrelated external cryptography probe. Root-preparation Python runs unmodified.
  const source = (await readFile(sourcePath, 'utf8')).replaceAll("/usr/bin/python3 -I -c 'import cryptography'", `"${bin}/crypto-present"`);
  const script = join(root, 'prerequisites');
  await writeFile(script, source);
  const run = (args: string[] = []) => exec('bash', [script, ...args], {
    env: { ...process.env, MATRIX_HOST_PREREQUISITES_ROOT: root, PATH: `${bin}:${process.env.PATH ?? ''}` }, timeout: 10_000,
  });
  return { root, home, marker, run };
}

describe('first upgrade workload-root preparation', () => {
  it('prepares every missing root even when system prerequisites are already certified', async () => {
    const { home, marker, run } = await fixture();
    // A predecessor already prepares bots; newly installed prerequisites must prepare the others.
    await mkdir(join(home, 'bots'));
    const before = await stat(marker);
    await run();
    for (const name of names) {
      const entry = await stat(join(home, name));
      expect(entry.isDirectory()).toBe(true);
      if (name !== 'bots') {
        expect(entry.mode & 0o777).toBe(0o750);
        expect(entry.uid).toBe(process.getuid!());
        expect(entry.gid).toBe(process.getgid!());
      }
    }
    expect((await stat(marker)).mtimeMs).toBe(before.mtimeMs);
  });

  it('preserves existing directory permissions, owner data and identity on repeated invocation', async () => {
    const { home, run } = await fixture();
    const before = [];
    for (const name of names) {
      const path = join(home, name);
      await mkdir(path);
      await chmod(path, 0o710);
      await writeFile(join(path, 'owner-data'), name);
      before.push(await stat(path));
    }
    await run(); await run();
    for (const [index, name] of names.entries()) {
      const after = await stat(join(home, name));
      expect([after.mode, after.uid, after.gid, after.ino]).toEqual([before[index]!.mode, before[index]!.uid, before[index]!.gid, before[index]!.ino]);
      expect(await readFile(join(home, name, 'owner-data'), 'utf8')).toBe(name);
    }
  });

  it.each(['root-symlink', 'parent-symlink', 'root-file', 'parent-file'])('fails closed for %s before creating any roots', async (kind) => {
    const { root, home, run } = await fixture();
    const outside = join(root, 'outside');
    await mkdir(outside);
    if (kind.startsWith('parent')) {
      await rm(home, { recursive: true });
      if (kind.endsWith('symlink')) await symlink(outside, home);
      else await writeFile(home, 'owner data');
    } else if (kind.endsWith('symlink')) await symlink(outside, join(home, 'worktrees'));
    else await writeFile(join(home, 'worktrees'), 'owner data');
    await expect(run()).rejects.toMatchObject({ code: 64 });
    await expect(stat(join(outside, 'bots'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (kind.startsWith('root')) await expect(stat(join(home, 'bots'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips owner roots before the Matrix account exists, including golden-image certification', async () => {
    const { home, run } = await fixture(false);
    await run(); await run(['--certify-only']);
    for (const name of names) await expect(stat(join(home, name))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves owner-home creation to fresh activation even if account setup has already run', async () => {
    const { root, home, run } = await fixture();
    await rm(join(root, 'home'), { recursive: true });
    await run();
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects account lookup failure instead of treating it as a pre-activation missing account', async () => {
    const { home, run } = await fixture('lookup-error');
    await expect(run()).rejects.toMatchObject({ code: 64 });
    for (const name of names) await expect(stat(join(home, name))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
