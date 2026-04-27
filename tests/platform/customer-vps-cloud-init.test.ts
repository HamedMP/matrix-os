import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  redactCloudInitSecrets,
  renderCloudInitTemplate,
  type CustomerHostConfig,
} from '../../packages/platform/src/customer-vps-cloud-init.js';

describe('platform/customer-vps-cloud-init', () => {
  const input: CustomerHostConfig = {
    machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
    clerkUserId: 'user_123',
    handle: 'alice',
    imageVersion: 'matrix-os-host-2026.04.26-1',
    hostBundleUrl: 'https://platform.example/system-bundles/matrix-os-host-2026.04.26-1/matrix-host-bundle.tar.gz',
    platformRegisterUrl: 'https://platform.example/vps/register',
    registrationToken: 'registration-secret',
    r2Bucket: 'matrixos-sync',
    r2Prefix: 'matrixos-sync/user_123/',
    postgresPassword: 'postgres-secret',
  };

  it('renders required host variables into the cloud-init template', () => {
    const rendered = renderCloudInitTemplate(
      'id={{machineId}}\nuser={{clerkUserId}}\nhandle={{handle}}\nurl={{platformRegisterUrl}}\nr2={{r2Prefix}}\n',
      input,
    );

    expect(rendered).toContain('id=9f05824c-8d0a-4d83-9cb4-b312d43ff112');
    expect(rendered).toContain('user=user_123');
    expect(rendered).toContain('handle=alice');
    expect(rendered).toContain('url=https://platform.example/vps/register');
    expect(rendered).toContain('r2=matrixos-sync/user_123/');
  });

  it('renders a non-empty host bundle URL into customer cloud-init', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const rendered = renderCloudInitTemplate(cloudInit, input);

    expect(rendered).toContain(
      'MATRIX_HOST_BUNDLE_URL=https://platform.example/system-bundles/matrix-os-host-2026.04.26-1/matrix-host-bundle.tar.gz',
    );
    expect(rendered).not.toContain('MATRIX_HOST_BUNDLE_URL=\n');
  });

  it('uses a retrying bounded download for the host bundle and sha sidecar', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit).toContain('curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors --connect-timeout 10 --max-time 900 "$MATRIX_HOST_BUNDLE_URL"');
    expect(cloudInit).toContain('curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors --connect-timeout 10 --max-time 30 "${MATRIX_HOST_BUNDLE_URL}.sha256"');
  });

  it('redacts bootstrap secrets before logging rendered cloud-init', () => {
    const rendered = renderCloudInitTemplate(
      'token={{registrationToken}}\npassword={{postgresPassword}}\n',
      input,
    );

    const redacted = redactCloudInitSecrets(rendered, input);

    expect(redacted).not.toContain('registration-secret');
    expect(redacted).not.toContain('postgres-secret');
    expect(redacted).toContain('[redacted]');
  });

  it('orders gateway and shell behind restore completion on customer hosts', () => {
    const root = process.cwd();
    const gateway = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-gateway.service'), 'utf8');
    const shell = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-shell.service'), 'utf8');
    const restore = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-restore.service'), 'utf8');

    expect(gateway).toContain('Requires=matrix-restore.service');
    expect(gateway).toContain('ConditionPathExists=/opt/matrix/restore-complete');
    expect(gateway).toContain('ConditionPathExists=/opt/matrix/bin/matrix-gateway');
    expect(shell).toContain('After=matrix-gateway.service');
    expect(shell).toContain('ConditionPathExists=/opt/matrix/bin/matrix-shell');
    expect(readFileSync(join(root, 'distro/customer-vps/systemd/matrix-sync-agent.service'), 'utf8')).toContain(
      'ConditionPathExists=/opt/matrix/bin/matrix-sync-agent',
    );
    expect(restore).toContain('Type=oneshot');
  });

  it('uploads DB snapshots before updating latest without calling deferred pruning', () => {
    const root = process.cwd();
    const backup = readFileSync(join(root, 'distro/customer-vps/matrix-db-backup.sh'), 'utf8');

    expect(backup.indexOf('matrixctl r2 put "$snapshot_path" "$snapshot_key"')).toBeLessThan(
      backup.indexOf('matrixctl r2 put-latest "$snapshot_key"'),
    );
    expect(backup).not.toContain('matrixctl r2 prune system/db/snapshots/');
    expect(backup).toContain('--format=custom');
    expect(backup).toContain('.dump');
    expect(backup).toContain('timeout');
  });

  it('keeps restore as a boot gate and refuses failed restores', () => {
    const root = process.cwd();
    const restore = readFileSync(join(root, 'distro/customer-vps/matrix-restore.sh'), 'utf8');
    const gateway = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-gateway.service'), 'utf8');

    expect(restore).toContain('restore-complete');
    expect(restore).toContain('pg_isready');
    expect(restore.indexOf('pg_isready')).toBeLessThan(restore.indexOf('pg_restore'));
    expect(restore).toContain('pg_restore');
    expect(restore).toContain('exit 1');
    expect(gateway).toContain('ConditionPathExists=/opt/matrix/restore-complete');
  });

  it('runs DB backup on an hourly systemd timer', () => {
    const root = process.cwd();
    const service = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-db-backup.service'), 'utf8');
    const timer = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-db-backup.timer'), 'utf8');

    expect(service).toContain('ExecStart=/opt/matrix/bin/matrix-db-backup.sh');
    expect(timer).toContain('OnCalendar=hourly');
    expect(timer).toContain('Persistent=true');
  });

  it('installs backup artifacts into cloud-init with restrictive modes', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit).toContain('path: /opt/matrix/bin/matrixctl');
    expect(cloudInit).toContain('path: /opt/matrix/bin/matrix-db-backup.sh');
    expect(cloudInit).toContain('path: /opt/matrix/bin/matrix-restore.sh');
    expect(cloudInit).toContain('path: /etc/systemd/system/matrix-db-backup.timer');
    expect(cloudInit).toContain('permissions: "0750"');
    expect(cloudInit).toContain('awscli postgresql-client');
    expect(cloudInit).toContain('systemctl enable matrix-restore.service matrix-gateway.service matrix-shell.service matrix-sync-agent.service matrix-db-backup.timer');
  });

  it('includes a bounded matrixctl recovery wrapper', () => {
    const root = process.cwd();
    const matrixctl = readFileSync(join(root, 'distro/customer-vps/matrixctl'), 'utf8');
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(matrixctl).toContain('matrixctl recover <clerk-user-id> [--allow-empty]');
    expect(matrixctl).toContain('${MATRIX_PLATFORM_URL%/}/vps/recover');
    expect(matrixctl).toContain('curl --fail --silent --show-error --max-time 10');
    expect(cloudInit).toContain('matrixctl recover <clerk-user-id> [--allow-empty]');
  });
});
