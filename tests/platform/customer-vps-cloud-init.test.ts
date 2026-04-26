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
    expect(shell).toContain('After=matrix-gateway.service');
    expect(restore).toContain('Type=oneshot');
  });
});
