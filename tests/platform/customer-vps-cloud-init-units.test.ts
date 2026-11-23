import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

// Hetzner caps user_data at 32KiB, so cloud-init.yaml carries only the units
// the host bundle cannot install for it.
describe('customer VPS cloud-init systemd unit sources', () => {
  const root = process.cwd();
  const bundleUnitDir = join(root, 'distro/customer-vps/systemd');
  const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
  const document = parseDocument(cloudInit).toJS() as {
    write_files: { path: string }[];
    runcmd: string[];
  };
  const writtenUnits = document.write_files
    .map((file) => file.path)
    .filter((path) => path.startsWith('/etc/systemd/system/'))
    .map((path) => path.slice('/etc/systemd/system/'.length));
  const bootstrap = document.runcmd.join('\n');
  const activatedUnits = [
    ...new Set(
      [...bootstrap.matchAll(/systemctl\s+(?:enable|start|restart)\b([^|;&\n]*)/g)].flatMap((match) =>
        match[1].split(/\s+/).filter((token) => /^matrix-[\w.-]+\.(?:service|timer)$/.test(token)),
      ),
    ),
  ];

  it('does not duplicate services the host bundle installs over the cloud-init copy', () => {
    // Bootstrap copies /opt/matrix/systemd/*.service over /etc/systemd/system
    // before any Matrix unit is reloaded, enabled, or started, so a cloud-init
    // copy of a bundled service only spends Hetzner's 32KiB user_data budget.
    expect(bootstrap).toContain('install -o root -g root -m 0644 /opt/matrix/systemd/*.service /etc/systemd/system/');
    const duplicated = writtenUnits.filter(
      (unit) => unit.endsWith('.service') && existsSync(join(bundleUnitDir, unit)),
    );
    expect(duplicated).toEqual([]);
  });

  it('keeps timers in user data because the bundle install only copies services', () => {
    const timers = activatedUnits.filter((unit) => unit.endsWith('.timer'));
    expect(timers).toContain('matrix-db-backup.timer');
    for (const timer of timers) expect(writtenUnits).toContain(timer);
  });

  it('provides every unit bootstrap enables or starts from user data or the host bundle', () => {
    expect(activatedUnits).toEqual(expect.arrayContaining(['matrix-gateway.service', 'matrix-hermes.service', 'matrix-db-backup.timer']));
    const missing = activatedUnits.filter(
      (unit) => !writtenUnits.includes(unit) && !existsSync(join(bundleUnitDir, unit)),
    );
    expect(missing).toEqual([]);
  });
});
