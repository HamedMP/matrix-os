import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const sanitizePath = 'distro/customer-vps/host-bin/matrix-golden-snapshot-sanitize';
const validatePath = 'distro/customer-vps/host-bin/matrix-golden-snapshot-validate';
const activatePath = 'distro/customer-vps/host-bin/matrix-golden-snapshot-activate';

describe('golden snapshot host scripts', () => {
  it('removes every forbidden-state category from an isolated synthetic root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-golden-sanitize-'));
    const forbidden = [
      'etc/matrix/platform.env',
      'var/lib/matrix/provisioning-complete',
      'home/matrix/home/conversations/secret.json',
      'home/matrix/.ssh/authorized_keys',
      'etc/ssh/ssh_host_ed25519_key',
      'etc/matrix/tls/server.key',
      'var/lib/systemd/random-seed',
      'var/lib/cloud/instances/i-123/state',
      'var/lib/dhcp/dhclient.leases',
      'home/matrix/.bash_history',
      'home/matrix/.npmrc',
      'run/matrix/bootstrap-token',
      'var/lib/docker/volumes/customer/_data/db',
      'var/log/matrix-builder.log',
    ];
    for (const relative of forbidden) {
      const absolute = join(root, relative);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, 'synthetic-secret');
    }
    await mkdir(join(root, 'etc/matrix'), { recursive: true });
    await writeFile(join(root, 'etc/matrix/golden-snapshot-builder'), '1');
    await writeFile(join(root, 'etc/machine-id'), 'builder-machine-id\n');
    await chmod(sanitizePath, 0o755);

    await execFileAsync(sanitizePath, [], { env: { ...process.env, MATRIX_GOLDEN_SNAPSHOT_ROOT: root } });

    for (const relative of forbidden) {
      await expect(stat(join(root, relative))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(root, 'etc/machine-id'), 'utf8')).toBe('');
    const evidence = await readFile(join(root, 'var/lib/matrix/golden-snapshot-sanitized'), 'utf8');
    expect(evidence).toContain('sanitized=true');
    expect(evidence).toContain('clean:/etc/matrix');
    expect(evidence).toContain('clean:/var/lib/docker/volumes');
    expect(evidence).toContain('clean:/etc/machine-id');
  });

  it('fails closed when a forbidden path survives and emits only coarse validation evidence', async () => {
    const source = await readFile(validatePath, 'utf8');
    const activationSource = await readFile(activatePath, 'utf8');
    expect(source).toContain('forbidden_state_absent');
    expect(source).toContain('exact_bundle');
    expect(source).toContain('unique_machine_id');
    expect(source).toContain('validationMachineIdSha256');
    expect(source).toContain('validationSshHostKeySha256');
    expect(source).toContain('"phase": "validated"');
    expect(source).toContain('"exactBundle"');
    expect(source).toContain('/opt/matrix/app/BUNDLE_SHA256');
    expect(source).not.toContain('json.load');
    expect(source).not.toContain('release_sha256');
    expect(source).not.toContain('cat /etc/matrix/platform.env');
    for (const forbiddenPath of [
      '/etc/matrix', '/opt/matrix/env', '/opt/matrix/config', '/opt/matrix/secrets',
      '/opt/matrix/tls', '/home/matrix/home', '/home/matrix/.hermes',
      '/home/matrix/.ssh', '/root/.ssh', '/home/matrix/.npmrc', '/root/.npmrc',
      '/var/lib/docker/volumes', '/var/lib/containerd', '/var/log/matrix',
      '/var/log/matrix-builder.log',
    ]) {
      expect(activationSource).toContain(forbiddenPath);
      expect(source).toContain(forbiddenPath);
    }
    expect(activationSource).toContain('matrix-golden-preactivation-clean');
    expect(source).toContain('required_clean_evidence');
  });

  it('keeps builder inputs immutable and customer-free', async () => {
    const source = await readFile('distro/customer-vps/golden-snapshot-builder-cloud-init.yaml', 'utf8');
    const runCommands = source.slice(source.indexOf('runcmd:'));
    expect(runCommands).toContain('runcmd:\n  - |\n    set -eu');
    expect(runCommands.match(/^  - /gm)).toHaveLength(1);
    expect(runCommands.indexOf('sha256sum -c -')).toBeLessThan(runCommands.indexOf("'{{callbackUrl}}'"));
    expect(runCommands).toContain('--retry-all-errors');
    expect(source).toContain('{{bundleVersion}}');
    expect(source).toContain('{{bundleSha256}}');
    expect(source).toContain('{{callbackToken}}');
    expect(source).not.toContain('authorization: Bearer {{callbackToken}}');
    expect(runCommands).toContain('callbackToken="$(cat /run/matrix-golden-snapshot-callback-token)"');
    expect(runCommands.indexOf('callbackToken="$(cat /run/matrix-golden-snapshot-callback-token)"'))
      .toBeLessThan(runCommands.indexOf('MATRIX_GOLDEN_SNAPSHOT_ROOT=/ /opt/matrix/bin/matrix-golden-snapshot-sanitize'));
    expect(runCommands).toContain('curl --config -');
    expect(runCommands).not.toContain('-H "authorization: Bearer $callbackToken"');
    expect(source).toContain("permissions: '0600'");
    expect(source).toContain('matrix-golden-snapshot-activate');
    expect(source).toContain('builderMachineIdSha256');
    expect(source).toContain('builderSshHostKeySha256');
    expect(source).toContain("printf '%s\\n' '{{bundleVersion}}' >/opt/matrix/app/BUNDLE_VERSION");
    expect(source).toContain("printf '%s\\n' '{{bundleSha256}}' >/opt/matrix/app/BUNDLE_SHA256");
    expect(source).not.toContain('{{clerkUserId}}');
    expect(source).not.toContain('{{registrationToken}}');
  });

  it('overwrites free blocks and scans the raw root device without secret command arguments', async () => {
    const source = await readFile(sanitizePath, 'utf8');
    expect(source).toContain('/run/matrix-golden-snapshot-scan-patterns');
    expect(source).toContain('findmnt -n -o SOURCE --target /');
    expect(source).toContain('dd if=/dev/zero');
    expect(source).toContain('No space left on device');
    expect(source).toContain('sync');
    expect(source).toContain('timeout --signal=KILL 600 grep -aF -f "$patterns_file"');
    expect(source).not.toContain('grep -aF -- "$callback_token"');
    expect(source.indexOf('dd if=/dev/zero')).toBeLessThan(source.indexOf('grep -aF -f'));
  });

  it('uses one credential-free activation path for builders and validation clones', async () => {
    const source = await readFile(activatePath, 'utf8');
    expect(source).toContain('matrix-golden-validation');
    expect(source).toContain('systemctl daemon-reload');
    expect(source).toContain('matrix-gateway.service');
    expect(source).toContain('matrix-shell.service');
    expect(source).toContain('matrix-sync-agent.service');
    expect(source).toContain('matrix-golden-preactivation-clean');
    expect(source).toContain('cloud-init query instance_id');
    expect(source).toContain('unexpected cloud-init instance state');
    expect(source).toContain('/root/.ssh');
    expect(source).not.toContain('PLATFORM_VERIFICATION_TOKEN');
    expect(source).not.toContain('R2_SECRET_ACCESS_KEY');
  });
});
