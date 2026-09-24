import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const prerequisitesPath = 'distro/customer-vps/host-bin/matrix-prepare-host-prerequisites';

async function markerWriter(): Promise<string> {
  const source = await readFile(prerequisitesPath, 'utf8');
  const writer = source.match(/^write_readiness_marker\(\) \{[\s\S]*?^\}/m)?.[0];
  if (!writer) throw new Error('Host prerequisite marker writer is missing');
  return writer;
}

function markerWriterCommand(writer: string): string {
  return [
    'set -euo pipefail',
    writer,
    'HOST_PREREQUISITES_VERSION=1',
    'root=/',
    'matrix_dir="$1"',
    'marker="$matrix_dir/HOST_PREREQUISITES_READY"',
    'write_readiness_marker',
  ].join('\n');
}

describe('host prerequisite directory access', () => {
  it('sets the live ownership contract and never certifies after directory setup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-host-prerequisites-ownership-'));
    try {
      const matrixDir = join(root, 'opt/matrix');
      const marker = join(matrixDir, 'HOST_PREREQUISITES_READY');
      const fakeBin = join(root, 'bin');
      const calls = join(root, 'calls');
      await mkdir(matrixDir, { recursive: true });
      await mkdir(fakeBin);
      await writeFile(join(fakeBin, 'getent'), '#!/bin/sh\nexit 2\n');
      await writeFile(join(fakeBin, 'groupadd'), '#!/bin/sh\nprintf "groupadd %s\\n" "$*" >> "$MATRIX_TEST_CALLS"\n');
      await writeFile(join(fakeBin, 'install'), '#!/bin/sh\nprintf "install %s\\n" "$*" >> "$MATRIX_TEST_CALLS"\n');
      await writeFile(join(fakeBin, 'chown'), '#!/bin/sh\nprintf "chown %s\\n" "$*" >> "$MATRIX_TEST_CALLS"\n');
      for (const command of ['getent', 'groupadd', 'install', 'chown']) {
        await chmod(join(fakeBin, command), 0o755);
      }

      const command = markerWriterCommand(await markerWriter());
      const options = {
        env: { ...process.env, MATRIX_TEST_CALLS: calls, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      };
      await execFileAsync('bash', ['-c', command, 'bash', matrixDir], options);
      expect(await readFile(calls, 'utf8')).toBe([
        'groupadd --system matrix',
        `install -d -o root -g matrix -m 0770 ${matrixDir}`,
        '',
      ].join('\n'));
      expect(await readFile(marker, 'utf8')).toBe('version=1\n');

      await rm(marker);
      await writeFile(join(fakeBin, 'install'), '#!/bin/sh\nexit 23\n');
      await expect(execFileAsync('bash', ['-c', command, 'bash', matrixDir], options))
        .rejects.toMatchObject({ code: 23 });
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const linuxCi = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true';
  (linuxCi ? it : it.skip)('allows the matrix group to traverse a real root-owned directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-host-prerequisites-access-'));
    try {
      const matrixDir = join(root, 'opt/matrix');
      const marker = join(matrixDir, 'HOST_PREREQUISITES_READY');
      await mkdir(matrixDir, { recursive: true });
      await chmod(root, 0o755);
      const command = markerWriterCommand(await markerWriter());
      await execFileAsync('sudo', ['-n', 'bash', '-c', command, 'bash', matrixDir]);

      const group = await execFileAsync('getent', ['group', 'matrix']);
      const groupId = Number(group.stdout.trim().split(':')[2]);
      const directory = await stat(matrixDir);
      expect(directory.uid).toBe(0);
      expect(directory.gid).toBe(groupId);
      expect(directory.mode & 0o777).toBe(0o770);
      await execFileAsync('sudo', ['-n', '-u', 'nobody', '-g', 'matrix', '--', 'test', '-x', matrixDir]);
      await execFileAsync('sudo', ['-n', '-u', 'nobody', '-g', 'matrix', '--', 'test', '-r', marker]);
    } finally {
      await execFileAsync('sudo', ['-n', 'rm', '-rf', '--', root]);
    }
  });
});
