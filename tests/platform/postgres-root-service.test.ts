import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('customer VPS PostgreSQL privilege boundary', () => {
  it('starts the fixed PostgreSQL container through a root system service', () => {
    const unit = read('distro/customer-vps/systemd/matrix-postgres.service');
    expect(unit).toContain('User=root');
    expect(unit).toContain('ExecStart=/usr/local/libexec/matrix-postgres-start');
    expect(unit).toContain('Requires=docker.service');
    expect(unit).not.toContain('RemainAfterExit=yes');
    const helper = read('distro/customer-vps/host-bin/matrix-postgres-start');
    expect(helper).toContain('matrix-postgres');
    expect(helper).toContain('127.0.0.1:5432:5432');
  });

  it('runs the owner-scoped restore only after the root service, without Docker access', () => {
    const unit = read('distro/customer-vps/systemd/matrix-restore.service');
    expect(unit).toContain('User=matrix');
    expect(unit).toContain('Requires=matrix-postgres.service');
    expect(unit).toContain('After=matrix-postgres.service');
    expect(read('distro/customer-vps/host-bin/matrix-restore.sh')).not.toMatch(/\bdocker\s+(?:ps|start|run|volume)\b/);
  });

  it('wires first boot and golden snapshot activation to the new service', () => {
    const cloudInit = read('distro/customer-vps/cloud-init.yaml');
    expect(cloudInit).toContain('/usr/local/libexec/matrix-postgres-start');
    expect(cloudInit).toContain('systemctl start matrix-postgres.service');
    expect(cloudInit).not.toMatch(/if docker ps --format/);
    expect(cloudInit).toContain('Requires=matrix-postgres.service');
    const golden = read('distro/customer-vps/host-bin/matrix-golden-snapshot-activate');
    expect(golden).toContain('/usr/local/libexec/matrix-postgres-start');
    expect(golden).toContain('matrix-postgres.service.d/golden.conf');
    expect(golden).toContain('matrix-postgres.service matrix-restore.service');
  });

  it('backs up the protected helper when an update replaces it and restores it on rollback', () => {
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    expect(updater).toContain('record_update_file /usr/local/libexec/matrix-postgres-start postgres-helper');
    expect(updater).toContain('restore_update_file /usr/local/libexec/matrix-postgres-start postgres-helper');
    expect(updater).toContain('install -o root -g root -m 0755 "$source_dir/matrix-postgres-start"');
    expect(updater).toContain('if [ -f "$UPDATE_TRANSACTION_DIR/postgres-helper.present" ] || [ -f "$UPDATE_TRANSACTION_DIR/postgres-helper.missing" ]; then');
  });
});
