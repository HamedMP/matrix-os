import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

it('sanitizes all Browser credentials, activation journals and profile state while retaining immutable bundle bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-golden-'));
  const sensitive = ['opt/matrix-browser-lab/viewer.passwd', 'opt/matrix-browser-lab/credential-pending.json',
    'opt/matrix-browser-lab/activation.json', 'opt/matrix-browser-lab/status.json',
    'home/matrix/.local/share/matrix-browser-lab/chrome/Default/Cookies',
    'etc/systemd/system/matrix-browser-lab-chrome.service',
    'etc/systemd/system/multi-user.target.wants/matrix-browser-runtime.service'];
  const retained = 'opt/matrix/bin/matrix-browser-runtime.tar.gz';
  try {
    for (const file of [...sensitive, retained, 'etc/matrix/golden-snapshot-builder']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), 'synthetic fixture');
    }
    execFileSync('bash', ['distro/customer-vps/host-bin/matrix-golden-snapshot-sanitize'], {
      env: { ...process.env, MATRIX_GOLDEN_SNAPSHOT_ROOT: root }, timeout: 10_000,
    });
    for (const file of sensitive) expect(existsSync(join(root, file)), file).toBe(false);
    expect(readFileSync(join(root, retained), 'utf8')).toBe('synthetic fixture');
    expect(readFileSync(join(root, 'var/lib/matrix/golden-snapshot-sanitized'), 'utf8'))
      .toContain('clean:/opt/matrix-browser-lab');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('requires clean Browser state in golden clone validation before first-owner cloud-init activation', () => {
  for (const name of ['matrix-golden-snapshot-activate', 'matrix-golden-snapshot-validate']) {
    const script = readFileSync(`distro/customer-vps/host-bin/${name}`, 'utf8');
    expect(script).toContain('/opt/matrix-browser-lab');
    expect(script).toContain('/etc/systemd/system/multi-user.target.wants/matrix-browser-runtime.service');
  }
  const cloud = readFileSync('distro/customer-vps/cloud-init.yaml', 'utf8');
  expect(cloud.indexOf('systemctl enable --now --no-block matrix-browser-runtime.service'))
    .toBeGreaterThan(cloud.indexOf('log_bootstrap_phase core_services_started'));
});
