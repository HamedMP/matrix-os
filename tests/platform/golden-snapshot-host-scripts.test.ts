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
      'etc/netplan/50-cloud-init.yaml',
      'etc/netplan/90-provider-static.yaml',
      'etc/systemd/network/10-provider-static.network',
      'home/matrix/.bash_history',
      'home/matrix/.npmrc',
      'run/matrix/bootstrap-token',
      'var/lib/docker/volumes/customer/_data/db',
      'var/log/matrix-builder.log',
      'var/crash/matrix-gateway.crash',
      'var/lib/systemd/coredump/core.matrix-gateway',
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
    const cloneNetworkFallback = await readFile(
      join(root, 'etc/systemd/network/99-matrix-golden-dhcp.network'),
      'utf8',
    );
    expect(cloneNetworkFallback).toBe([
      '[Match]',
      'Name=e*',
      '',
      '[Network]',
      'DHCP=ipv4',
      '',
    ].join('\n'));
    expect(cloneNetworkFallback).not.toMatch(/macaddress|addresses|set-name/i);
    await expect(stat(join(root, 'etc/netplan/60-matrix-golden-dhcp.yaml')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const evidence = await readFile(join(root, 'var/lib/matrix/golden-snapshot-sanitized'), 'utf8');
    expect(evidence).toContain('sanitized=true');
    expect(evidence).toContain('clean:/etc/matrix');
    expect(evidence).toContain('clean:/var/lib/docker/volumes');
    expect(evidence).toContain('clean:/etc/machine-id');
    expect(evidence).toContain('clean:/etc/netplan/50-cloud-init.yaml');
    expect(evidence).toContain('clean:/etc/netplan/provider-state');
    expect(evidence).toContain('clean:/etc/systemd/network/provider-state');
  });

  it('keeps the sanitized runtime state traversable under a restrictive builder umask', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-golden-sanitize-mode-'));
    await mkdir(join(root, 'etc/matrix'), { recursive: true });
    await writeFile(join(root, 'etc/matrix/golden-snapshot-builder'), '1');
    await chmod(sanitizePath, 0o755);

    await execFileAsync('bash', [
      '-c',
      'umask 077; exec "$1"',
      'matrix-golden-sanitize-mode',
      sanitizePath,
    ], { env: { ...process.env, MATRIX_GOLDEN_SNAPSHOT_ROOT: root } });

    const runtimeState = await stat(join(root, 'var/lib/matrix'));
    expect(runtimeState.mode & 0o777).toBe(0o755);
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
      '/var/log/matrix-builder.log', '/var/crash', '/var/lib/systemd/coredump',
    ]) {
      expect(activationSource).toContain(forbiddenPath);
      expect(source).toContain(forbiddenPath);
    }
    expect(activationSource).toContain('matrix-golden-preactivation-clean');
    expect(activationSource).toContain('/etc/systemd/network/99-matrix-golden-dhcp.network');
    expect(activationSource).toContain('golden snapshot clone network fallback invalid');
    expect(source).toContain('required_clean_evidence');
    expect(source).toContain('fresh_legacy_links=(.hermes .config .cache .local)');
    expect(source).toContain('expected_target="/home/matrix/home/$legacy"');
    expect(source).toContain('readlink -f -- "$legacy_path"');
    for (const script of [activationSource, source]) {
      expect(script).toContain('crash_dump_dirs=(/var/crash /var/lib/systemd/coredump)');
      expect(script).toContain('find -P "$crash_dir" -mindepth 1 -print -quit');
    }
  });

  it('emits schema-valid sentinel digests when validation identity files are missing', async () => {
    const source = await readFile(validatePath, 'utf8');
    expect(source).toContain("invalid_identity_sha256='0000000000000000000000000000000000000000000000000000000000000000'");
    expect(source).toContain('machine_id_sha256="$invalid_identity_sha256"');
    expect(source).toContain('ssh_host_key_sha256="$invalid_identity_sha256"');
  });

  it('keeps builder inputs immutable and customer-free', async () => {
    const source = await readFile('distro/customer-vps/golden-snapshot-builder-cloud-init.yaml', 'utf8');
    const runCommands = source.slice(source.indexOf('runcmd:'));
    expect(runCommands).toContain('runcmd:\n  - |\n    set -eu');
    expect(runCommands.match(/^  - /gm)).toHaveLength(1);
    expect(runCommands.indexOf('sha256sum -c -')).toBeLessThan(runCommands.lastIndexOf("'{{callbackUrl}}'"));
    expect(runCommands).toContain('--retry-all-errors');
    expect(source).toContain('{{bundleVersion}}');
    expect(source).toContain('{{bundleSha256}}');
    expect(source).toContain('{{callbackToken}}');
    expect(source).not.toContain('authorization: Bearer {{callbackToken}}');
    expect(source).toContain('path: /run/matrix-golden-snapshot-callback-token');
    expect(source).not.toContain('path: /run/matrix/golden-snapshot-callback-token');
    expect(runCommands).toContain('callbackToken="$(cat /run/matrix-golden-snapshot-callback-token)"');
    expect(runCommands.indexOf('callbackToken="$(cat /run/matrix-golden-snapshot-callback-token)"'))
      .toBeLessThan(runCommands.indexOf('MATRIX_GOLDEN_SNAPSHOT_ROOT=/ /opt/matrix/bin/matrix-golden-snapshot-sanitize'));
    expect(runCommands).toContain('curl --config -');
    expect(runCommands).not.toContain('-H "authorization: Bearer $callbackToken"');
    expect(runCommands).toContain('"phase":"failed"');
    expect(runCommands).toContain('"role":"builder"');
    expect(runCommands).toContain('"stage":"%s"');
    expect(runCommands).toContain('"$failureStage"');
    expect(runCommands).toContain('trap reportFailure EXIT');
    expect(runCommands).not.toContain('trap reportFailure ERR');
    expect(runCommands).toContain("failureStage='activation'");
    expect(runCommands).toContain('/run/matrix-golden-activation-stage');
    expect(runCommands).toContain("activation_docker_start|activation_postgres_pull|activation_postgres_start|activation_postgres_ready|activation_services_start|activation_services_ready");
    expect(runCommands).toContain("failureStage='sanitization'");
    expect(runCommands).toContain("68) reportedStage='sanitization_callback_material'");
    expect(runCommands).toContain("69) reportedStage='sanitization_root_device'");
    expect(runCommands).toContain("70) reportedStage='sanitization_free_blocks'");
    expect(runCommands).toContain("71) reportedStage='sanitization_residue'");
    expect(runCommands).toContain("72) reportedStage='sanitization_scan_execution'");
    expect(runCommands).not.toContain('"error":');
    expect(source).toContain("permissions: '0600'");
    expect(source).toContain(
      'timeout --kill-after=30 1200 /opt/matrix/bin/matrix-golden-snapshot-activate builder',
    );
    expect(source).toContain('builderMachineIdSha256');
    expect(source).toContain('builderSshHostKeySha256');
    expect(source).toContain("printf '%s\\n' '{{bundleVersion}}' >/opt/matrix/app/BUNDLE_VERSION");
    expect(source).toContain("printf '%s\\n' '{{bundleSha256}}' >/opt/matrix/app/BUNDLE_SHA256");
    expect(source).not.toContain('{{clerkUserId}}');
    expect(source).not.toContain('{{registrationToken}}');
  });

  it('defers final sanitation until after the builder cloud-final command exits', async () => {
    const source = await readFile('distro/customer-vps/golden-snapshot-builder-cloud-init.yaml', 'utf8');
    const activation = source.indexOf('/opt/matrix/bin/matrix-golden-snapshot-activate builder');
    const finalizer = source.indexOf("cat >/run/matrix-golden-finalize <<'MATRIX_GOLDEN_FINALIZER'");
    const finalizerEnd = source.indexOf('\n    MATRIX_GOLDEN_FINALIZER', finalizer);
    const unit = source.indexOf('cat >/run/systemd/system/matrix-golden-finalize.service');
    const unitEnd = source.indexOf('\n    MATRIX_GOLDEN_FINALIZER_UNIT', unit);
    const schedule = source.indexOf('systemctl start --no-block matrix-golden-finalize.service');
    const finalizerBody = source.slice(finalizer, finalizerEnd);
    const unitBody = source.slice(unit, unitEnd);

    expect(activation).toBeGreaterThan(-1);
    expect(finalizer).toBeGreaterThan(activation);
    expect(unit).toBeGreaterThan(finalizerEnd);
    expect(schedule).toBeGreaterThan(unitEnd);
    expect(finalizerBody).toContain('sleep 15');
    expect(finalizerBody.indexOf('sleep 15'))
      .toBeLessThan(finalizerBody.indexOf('cloud-final.service'));
    expect(finalizerBody).toContain('for _ in $(seq 1 120); do');
    expect(finalizerBody).toContain(
      'systemctl show --property=SubState --value cloud-final.service',
    );
    expect(finalizerBody).toContain('test "$cloudFinalSubState" = exited');
    expect(finalizerBody).not.toContain('cloud-init status --wait');
    expect(finalizerBody.indexOf('cloud-final.service'))
      .toBeLessThan(finalizerBody.indexOf('matrix-golden-snapshot-sanitize'));
    expect(finalizerBody).toContain("failureStage='cloud_final_wait'");
    expect(finalizerBody).toContain("failureStage='service_shutdown'");
    expect(finalizerBody).toContain("trap 'failureStage=finalizer_timeout; exit 73' TERM");
    expect(finalizerBody).toContain('matrix-golden-snapshot-sanitize');
    expect(finalizerBody).toContain("failureStage='callback_delivery'");
    expect(finalizerBody).toContain('shutdown -h now');
    expect(unitBody).toContain('After=cloud-final.service');
    expect(unitBody).toContain('KillMode=control-group');
    expect(unitBody).toContain('TimeoutStartSec=2500');
    expect(unitBody).toContain('ExecStart=/usr/bin/timeout --kill-after=90 2400 /usr/bin/env bash /run/matrix-golden-finalize');
    expect(source.slice(unitEnd, schedule)).toContain('systemctl daemon-reload');
    expect(source.slice(schedule)).toContain('failureArmed=0');
    expect(source).not.toContain('nohup timeout');
    expect(source).not.toContain('timeout --signal=KILL 1800 /run/matrix-golden-finalize');
    expect(source).not.toContain('systemd-run --unit=matrix-golden-finalize');
  });

  it('overwrites free blocks and scans the raw root device without secret command arguments', async () => {
    const source = await readFile(sanitizePath, 'utf8');
    expect(source).toContain('/run/matrix-golden-snapshot-scan-patterns');
    expect(source).toContain('findmnt -n -o SOURCE --target /');
    expect(source).toContain('dd if=/dev/zero');
    expect(source).toContain('No space left on device');
    expect(source).toContain('sync');
    expect(source).toContain('timeout --signal=KILL 600 grep -F -f "$patterns_file"');
    expect(source).not.toContain('grep -aF -f "$patterns_file" -- "$root_device"');
    expect(source).not.toContain('grep -aF -- "$callback_token"');
    expect(source).toContain('sensitive_targets=(');
    expect(source).toContain('var/lib/cloud');
    expect(source).toContain('var/lib/docker/volumes');
    expect(source).toContain('var/log/cloud-init-output.log');
    expect(source).toContain('for relative in "${sensitive_targets[@]}"; do');
    expect(source).toContain('sensitive_target="$(under_root "$relative")"');
    expect(source).toContain('find -P "$sensitive_target" -xdev -type f -print0');
    expect(source).not.toContain('find "$root" -xdev -type f -print0');
    expect(source).not.toContain('grep -alZF -f "$patterns_file"');
    expect(source).toContain('shred --iterations=1 --zero -- "$sensitive_file"');
    expect(source.indexOf('sensitive_targets=(')).toBeLessThan(source.indexOf('shred --iterations=1 --zero'));
    expect(source.indexOf('swapoff -a')).toBeLessThan(source.indexOf('shred --iterations=1 --zero'));
    expect(source.indexOf('dd if=/dev/zero')).toBeLessThan(source.indexOf('grep -F -f'));
    expect(source).toContain('0) echo "golden snapshot raw-device sanitation failed" >&2; exit 71');
    expect(source).toContain('*) echo "golden snapshot raw-device scan failed" >&2; exit 72');
  });

  it('uses one credential-free activation path for builders and validation clones', async () => {
    const source = await readFile(activatePath, 'utf8');
    expect(source).toContain('matrix-golden-validation');
    expect(source).toContain('systemctl daemon-reload');
    expect(source).toContain('matrix-gateway.service');
    expect(source).toContain('matrix-shell.service');
    expect(source).toContain('matrix-sync-agent.service');
    expect(source).toContain('matrix-golden-preactivation-clean');
    expect(source).toContain('activation_stage_file=/run/matrix-golden-activation-stage');
    expect(source).toContain('set_activation_stage activation_preflight_evidence');
    expect(source).toContain('set_activation_stage activation_preflight_forbidden_state');
    expect(source).toContain('set_activation_stage activation_preflight_runtime_state');
    expect(source).toContain('set_activation_stage activation_preflight_owner_state');
    expect(source).toContain('set_activation_stage activation_preflight_root_ssh_state');
    expect(source).toContain('set_activation_stage activation_preflight_root_local_state');
    expect(source).toContain('set_activation_stage activation_preflight_log_state');
    expect(source).toContain('set_activation_stage activation_preflight_cloud_init');
    expect(source).toContain('set_activation_stage activation_preflight_container_state');
    expect(source).toContain('set_activation_stage activation_docker_start');
    expect(source).toContain('set_activation_stage activation_postgres_pull');
    expect(source).toContain('set_activation_stage activation_services_start');
    expect(source).toContain('cloud-init query instance_id');
    expect(source).toContain('unexpected cloud-init instance state');
    expect(source).toContain('/root/.ssh');
    expect(source).toContain('[ ! -d /root/.ssh ]');
    expect(source).toContain('find -P /root/.ssh -mindepth 1 -maxdepth 1 ! -name authorized_keys -print -quit');
    expect(source).toContain('[ -s /root/.ssh/authorized_keys ]');
    expect(source).toContain('rm -f -- /root/.ssh/authorized_keys');
    expect(source).toContain('rmdir -- /root/.ssh');
    expect(source).not.toContain('PLATFORM_VERIFICATION_TOKEN');
    expect(source).not.toContain('R2_SECRET_ACCESS_KEY');
  });

  it('bounds the validation database image pull separately from container startup', async () => {
    const source = await readFile(activatePath, 'utf8');
    const pull = 'timeout --signal=KILL 300 docker pull postgres:16';
    const run = 'timeout --signal=KILL 60 docker run --pull=never -d --name matrix-golden-postgres';

    expect(source).toContain(pull);
    expect(source).toContain(run);
    expect(source.indexOf(pull)).toBeLessThan(source.indexOf(run));
    expect(source).not.toContain('docker run -d --name matrix-golden-postgres');
    expect(source).toContain('timeout --kill-after=30 120 systemctl enable --now docker.service');
    expect(source).toContain('timeout --kill-after=30 60 systemctl daemon-reload');
    expect(source).toContain(
      'timeout --kill-after=30 180 systemctl start matrix-restore.service matrix-gateway.service matrix-shell.service matrix-sync-agent.service',
    );
  });

  it('makes the synthetic runtime home writable before service wrappers initialize user links', async () => {
    const source = await readFile(activatePath, 'utf8');
    const parentHome = 'install -d -o matrix -g matrix -m 0750 /home/matrix\n';
    const ownerDirectories = 'install -d -o matrix -g matrix -m 0750 /home/matrix/home /home/matrix/projects';

    expect(source).toContain(parentHome);
    expect(source.indexOf(parentHome)).toBeLessThan(source.indexOf(ownerDirectories));
  });
});
