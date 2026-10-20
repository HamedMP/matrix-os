import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('native preview payload directory permissions', () => {
  it.each(['install.sh', 'update-experience.sh'])('%s keeps the installed service readable when its source is root-only', async name => {
    const root = await mkdtemp(join(tmpdir(), 'browser-preview-copy-'));
    try {
      const source = join(root, 'private-source'); const prefix = join(root, 'installed');
      await mkdir(source, { mode: 0o700 }); await chmod(source, 0o700);
      await writeFile(join(source, 'supervisor.mjs'), '// runtime');
      await mkdir(join(prefix, 'app'), { recursive: true, mode: 0o755 });
      const lines = (await readFile(`scripts/spikes/browser-vps/${name}`, 'utf8')).split('\n');
      const index = lines.findIndex(line => line.startsWith('tar -C'));
      // Execute the installer's real filesystem-copy block; ownership is tested
      // separately because the fixture deliberately runs without root.
      const block: string[] = [];
      for (const line of lines.slice(index)) {
        if (!/^(tar |chown |chmod )/.test(line)) break;
        block.push(line);
      }
      execFileSync('bash', ['-euc', `chown() { :; }\n${block.join('\n')}`], {
        env: { ...process.env, BASH_ENV: '/dev/null', LAB_SOURCE: source, LAB_PREFIX: prefix }, timeout: 10_000,
      });
      expect((await stat(join(prefix, 'app'))).mode & 0o777).toBe(0o755);
      expect(await readFile(join(prefix, 'app/supervisor.mjs'), 'utf8')).toBe('// runtime');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains a valid viewer credential pair when finishing a partial first install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-preview-credentials-'));
    try {
      const environment = join(root, 'host.env');
      await writeFile(join(root, 'viewer.passwd'), 'existing-password-hash');
      await writeFile(environment, 'MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic Zml4dHVyZQ=="\n');
      const script = await readFile('scripts/spikes/browser-vps/install.sh', 'utf8');
      const start = script.indexOf('if [ ! -f "$LAB_PREFIX/viewer.passwd" ]');
      expect(start).toBeGreaterThan(0);
      const block = script.slice(start, script.indexOf('cat > /etc/systemd/system/matrix-browser-lab-vnc.service'))
        .replaceAll('/opt/matrix/env/host.env', environment);
      const command = `python3() { echo rotated > "$LAB_PREFIX/rotated"; }\n${block}`;
      const options = { env: { ...process.env, BASH_ENV: '/dev/null', LAB_PREFIX: root }, timeout: 10_000 };
      execFileSync('bash', ['-euc', command], options);
      await expect(readFile(join(root, 'rotated'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(root, 'viewer.passwd'), 'utf8')).toBe('existing-password-hash');
      // An incomplete pair is regenerated so a failed first attempt can recover.
      await writeFile(environment, '');
      execFileSync('bash', ['-euc', command], options);
      expect(await readFile(join(root, 'rotated'), 'utf8')).toBe('rotated\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
