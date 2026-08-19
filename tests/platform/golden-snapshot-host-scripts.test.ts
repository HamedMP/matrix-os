import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const sanitizePath = 'distro/customer-vps/host-bin/matrix-golden-snapshot-sanitize';
const validatePath = 'distro/customer-vps/host-bin/matrix-golden-snapshot-validate';
const activatePath = 'distro/customer-vps/host-bin/matrix-golden-snapshot-activate';
const fastPathPath = 'distro/customer-vps/host-bin/matrix-golden-snapshot-fast-path';
const awsCliSmokePath = 'distro/customer-vps/host-bin/matrix-aws-cli-smoke';

describe('golden snapshot host scripts', () => {
  it('allows the fast path only for a baked exact-bundle snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-golden-fast-path-'));
    const appDir = join(root, 'opt/matrix/app');
    await mkdir(appDir, { recursive: true });
    await writeFile(join(root, 'opt/matrix/golden-snapshot-system-ready'), 'matrix-host-prerequisites-v1\n');
    await writeFile(join(appDir, 'BUNDLE_VERSION'), 'v2026.08.19-test\n');
    await writeFile(join(appDir, 'BUNDLE_SHA256'), `${'a'.repeat(64)}\n`);
    await chmod(fastPathPath, 0o755);

    const exactEnv = {
      ...process.env,
      MATRIX_GOLDEN_SNAPSHOT_ROOT: root,
      MATRIX_IMAGE_SOURCE: 'snapshot',
      MATRIX_IMAGE_VERSION: 'v2026.08.19-test',
      MATRIX_SNAPSHOT_SOURCE_VERSION: 'v2026.08.19-test',
      MATRIX_TARGET_BUNDLE_SHA256: 'a'.repeat(64),
    };
    await expect(execFileAsync(fastPathPath, [], { env: exactEnv })).resolves.toMatchObject({ stdout: '' });

    await expect(execFileAsync(fastPathPath, [], {
      env: { ...exactEnv, MATRIX_TARGET_BUNDLE_SHA256: 'b'.repeat(64) },
    })).rejects.toMatchObject({ code: 1 });
    await expect(execFileAsync(fastPathPath, [], {
      env: { ...exactEnv, MATRIX_SNAPSHOT_SOURCE_VERSION: 'older' },
    })).rejects.toMatchObject({ code: 1 });
  });

  it('rejects missing or symlinked fast-path evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-golden-fast-path-evidence-'));
    const appDir = join(root, 'opt/matrix/app');
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, 'BUNDLE_VERSION'), 'v1\n');
    await writeFile(join(appDir, 'BUNDLE_SHA256'), `${'c'.repeat(64)}\n`);
    await chmod(fastPathPath, 0o755);
    const env = {
      ...process.env,
      MATRIX_GOLDEN_SNAPSHOT_ROOT: root,
      MATRIX_IMAGE_SOURCE: 'snapshot',
      MATRIX_IMAGE_VERSION: 'v1',
      MATRIX_SNAPSHOT_SOURCE_VERSION: 'v1',
      MATRIX_TARGET_BUNDLE_SHA256: 'c'.repeat(64),
    };

    await expect(execFileAsync(fastPathPath, [], { env })).rejects.toMatchObject({ code: 1 });
    const externalMarker = join(root, 'external-marker');
    await writeFile(externalMarker, 'matrix-host-prerequisites-v1\n');
    await symlink(externalMarker, join(root, 'opt/matrix/golden-snapshot-system-ready'));
    await expect(execFileAsync(fastPathPath, [], { env })).rejects.toMatchObject({ code: 1 });
  });

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
      'var/lib/systemd/linger/matrix',
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
    await mkdir(join(root, 'opt/matrix'), { recursive: true });
    await writeFile(join(root, 'opt/matrix/golden-snapshot-system-ready'), 'matrix-host-prerequisites-v1\n');
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
    expect(evidence).toContain('clean:/var/lib/systemd/linger/matrix');
    expect(evidence).toContain('clean:/var/lib/docker/volumes');
    expect(evidence).toContain('clean:/etc/machine-id');
    expect(evidence).toContain('clean:/etc/netplan/50-cloud-init.yaml');
    expect(evidence).toContain('clean:/etc/netplan/provider-state');
    expect(evidence).toContain('clean:/etc/systemd/network/provider-state');
    expect(await readFile(join(root, 'opt/matrix/golden-snapshot-system-ready'), 'utf8'))
      .toBe('matrix-host-prerequisites-v1\n');
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

  it('quiesces the lingering matrix user manager before removing snapshot state', async () => {
    const source = await readFile(sanitizePath, 'utf8');
    const disableLinger = source.indexOf('loginctl disable-linger matrix');
    const terminateUser = source.indexOf('loginctl terminate-user matrix');
    const stopUserManager = source.indexOf('systemctl stop "user@${matrix_uid}.service"');
    const verifyStopped = source.indexOf('pgrep -u matrix');
    const removeState = source.indexOf('for relative in "${remove_targets[@]}"; do');

    expect(disableLinger).toBeGreaterThan(-1);
    expect(terminateUser).toBeGreaterThan(disableLinger);
    expect(stopUserManager).toBeGreaterThan(terminateUser);
    expect(verifyStopped).toBeGreaterThan(stopUserManager);
    expect(removeState).toBeGreaterThan(verifyStopped);
    expect(source).toContain('timeout --kill-after=5 30 loginctl disable-linger matrix');
    expect(source).toContain('golden snapshot matrix user quiescence failed');
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
    expect(source).toContain('fast_path_ready');
    expect(source).toContain('/opt/matrix/bin/matrix-golden-snapshot-fast-path');
    expect(source).not.toContain('json.load');
    expect(source).not.toContain('release_sha256');
    expect(source).not.toContain('cat /etc/matrix/platform.env');
    for (const forbiddenPath of [
      '/etc/matrix', '/opt/matrix/env', '/opt/matrix/config', '/opt/matrix/secrets',
      '/opt/matrix/tls', '/home/matrix/home', '/home/matrix/.hermes',
      '/home/matrix/.ssh', '/root/.ssh', '/home/matrix/.npmrc', '/root/.npmrc',
      '/var/lib/systemd/linger/matrix',
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

  it('rejects a validation clone with baked matrix linger state before activation', async () => {
    const activationSource = await readFile(activatePath, 'utf8');
    const preflight = activationSource.indexOf('set_activation_stage activation_preflight_runtime_state');
    const lingerMarker = activationSource.indexOf('/var/lib/systemd/linger/matrix', preflight);
    const lingerState = activationSource.indexOf('loginctl show-user matrix --property=Linger --value');
    const userManager = activationSource.indexOf('systemctl is-active --quiet "user@${matrix_uid}.service"');
    const runtimeSetup = activationSource.indexOf('set_activation_stage activation_runtime_setup');

    expect(preflight).toBeGreaterThan(-1);
    expect(lingerState).toBeGreaterThan(preflight);
    expect(lingerMarker).toBeGreaterThan(preflight);
    expect(userManager).toBeGreaterThan(lingerState);
    expect(userManager).toBeGreaterThan(lingerMarker);
    expect(runtimeSetup).toBeGreaterThan(userManager);
    expect(activationSource).toContain('golden snapshot inherited matrix linger state found');
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

  it('bakes all clean-boot prerequisites before certifying a fast snapshot', async () => {
    const source = await readFile('distro/customer-vps/golden-snapshot-builder-cloud-init.yaml', 'utf8');
    const activation = source.indexOf('/opt/matrix/bin/matrix-golden-snapshot-activate builder');
    const normalizeOwnership = source.indexOf('chown -R root:matrix /opt/matrix/bin /opt/matrix/app /opt/matrix/runtime');
    const normalizeWrites = source.indexOf('chmod -R g+rwX /opt/matrix/app');
    const readiness = source.indexOf("printf '%s\\n' matrix-host-prerequisites-v1 >/opt/matrix/golden-snapshot-system-ready");

    for (const packageName of [
      'bubblewrap', 'build-essential', 'ca-certificates', 'cmatrix', 'curl', 'docker.io',
      'elixir', 'erlang-base', 'file', 'git', 'nginx', 'openssl', 'postgresql-client',
      'procps', 'socat', 'sudo', 'unzip', 'zsh',
    ]) {
      expect(source).toMatch(new RegExp(`^  - ${packageName}$`, 'm'));
    }
    expect(source).toContain('https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip');
    expect(source).toContain('command -v "$required_command" >/dev/null');
    expect(normalizeOwnership).toBeGreaterThan(activation);
    expect(normalizeWrites).toBeGreaterThan(normalizeOwnership);
    expect(readiness).toBeGreaterThan(normalizeWrites);
    expect(readiness).toBeGreaterThan(activation);
    const buildScript = await readFile('scripts/build-host-bundle.sh', 'utf8');
    expect(buildScript).toContain('matrix-golden-snapshot-fast-path');
  });

  it('functionally certifies the baked AWS CLI before snapshot readiness and validation', async () => {
    const builder = await readFile('distro/customer-vps/golden-snapshot-builder-cloud-init.yaml', 'utf8');
    const validator = await readFile(validatePath, 'utf8');
    const awsExecution = builder.indexOf('/opt/matrix/bin/matrix-aws-cli-smoke');
    const readiness = builder.indexOf(
      "printf '%s\\n' matrix-host-prerequisites-v1 >/opt/matrix/golden-snapshot-system-ready",
    );

    expect(awsExecution).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(awsExecution);
    expect(validator).toContain('aws_cli_ready=false');
    expect(validator).toContain('/opt/matrix/bin/matrix-aws-cli-smoke');
    expect(validator).toContain('[ "$aws_cli_ready" = true ]');
  });

  it('certifies the baked AWS CLI through a credential-free S3-compatible boundary', async () => {
    const [builder, validator, smoke, buildScript] = await Promise.all([
      readFile('distro/customer-vps/golden-snapshot-builder-cloud-init.yaml', 'utf8'),
      readFile(validatePath, 'utf8'),
      readFile(awsCliSmokePath, 'utf8'),
      readFile('scripts/build-host-bundle.sh', 'utf8'),
    ]);

    expect(builder).toContain('/opt/matrix/bin/matrix-aws-cli-smoke');
    expect(validator).toContain('/opt/matrix/bin/matrix-aws-cli-smoke');
    expect(smoke).toContain('s3api head-object');
    expect(smoke).toContain('s3 cp');
    expect(smoke).toContain('endpoint="http://127.0.0.1:${port}"');
    expect(smoke).toContain('--endpoint-url "$endpoint"');
    expect(smoke).toContain('AWS_ACCESS_KEY_ID=matrix-golden-smoke');
    expect(smoke).toContain('timeout --preserve-status 20 aws');
    expect(buildScript).toContain('matrix-aws-cli-smoke');
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

  it('overwrites ext4 runtime-reserved clusters and restores the exact reservation', async () => {
    const source = await readFile(sanitizePath, 'utf8');
    const locateRootDevice = source.indexOf('findmnt -n -r -o MAJ:MIN --target /');
    const locateExt4Control = source.indexOf('/sys/fs/ext4/$root_device_name/reserved_clusters');
    const saveReservation = source.indexOf('reserved_clusters_original="$(<"$reserved_clusters_file")"');
    const exposeReservation = source.indexOf('printf \'0\\n\' > "$reserved_clusters_file"');
    const fillFreeBlocks = source.indexOf('dd if=/dev/zero');
    const removeFill = source.indexOf('rm -f -- "$zero_fill"', fillFreeBlocks);
    const restoreReservation = source.indexOf('if ! restore_reserved_clusters; then', removeFill);

    expect(locateRootDevice).toBeGreaterThan(-1);
    expect(locateExt4Control).toBeGreaterThan(locateRootDevice);
    expect(saveReservation).toBeGreaterThan(locateExt4Control);
    expect(exposeReservation).toBeGreaterThan(saveReservation);
    expect(fillFreeBlocks).toBeGreaterThan(exposeReservation);
    expect(removeFill).toBeGreaterThan(fillFreeBlocks);
    expect(restoreReservation).toBeGreaterThan(removeFill);
    expect(source).toContain('reserved_clusters_changed=1');
    expect(source).toContain('restore_reserved_clusters');
    expect(source).toContain(
      'printf \'%s\\n\' "$reserved_clusters_original" > "$reserved_clusters_file"',
    );
    expect(source).not.toContain('/sys/fs/ext4/sda1/');
    expect(source).not.toContain('findmnt -n -o MAJ:MIN --target /');
  });

  it('restores the ext4 runtime reservation when sanitation is interrupted', async () => {
    const source = await readFile(sanitizePath, 'utf8');
    const exitCleanup = source.indexOf('trap cleanup_runtime_evidence EXIT');
    const signalExit = source.indexOf("trap 'exit 70' HUP INT TERM");
    const cleanupFunction = source.slice(
      source.indexOf('cleanup_runtime_evidence() {'),
      exitCleanup,
    );

    expect(exitCleanup).toBeGreaterThan(-1);
    expect(signalExit).toBeGreaterThan(exitCleanup);
    expect(cleanupFunction).toContain('restore_reserved_clusters');
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

  it('installs activated user-systemd terminal prerequisites before starting the gateway', async () => {
    const source = await readFile(activatePath, 'utf8');
    const runtimeSetup = source.indexOf('set_activation_stage activation_terminal_runtime');
    const serviceStart = source.indexOf('set_activation_stage activation_services_start');

    expect(runtimeSetup).toBeGreaterThan(-1);
    expect(runtimeSetup).toBeLessThan(serviceStart);
    expect(source).toContain('/opt/matrix/app/TERMINAL_USER_SYSTEMD_ENABLED');
    expect(source).toContain('chown -R root:root /opt/matrix/terminal-runtime');
    expect(source).toContain('for unit in matrix-zellij@.service matrix-terminal.slice; do');
    expect(source).toContain('"/opt/matrix/user-systemd/$unit"');
    expect(source).toContain('"/etc/systemd/user/$unit"');
    expect(source).toContain('timeout --kill-after=10 30 loginctl enable-linger matrix');
    expect(source).toContain('timeout --kill-after=10 30 systemctl start "user@${matrix_uid}.service"');
    expect(source).toContain('timeout --kill-after=10 30 runuser -u matrix');
    expect(source).toContain('systemctl --user daemon-reload');
    for (const stage of [
      'activation_gateway_ready',
      'activation_shell_ready',
      'activation_sync_agent_ready',
      'activation_gateway_health',
    ]) {
      expect(source).toContain(`set_activation_stage ${stage}`);
    }
  });

  it('regenerates clone identity and verifies the exact target digest before activation', async () => {
    const source = await readFile('distro/customer-vps/cloud-init.yaml', 'utf8');
    expect(source).toContain('systemd-machine-id-setup');
    expect(source).toContain('ssh-keygen -A');
    expect(source).toMatch(/if \[ "\$\{MATRIX_IMAGE_SOURCE:-clean_image\}" = "snapshot" \]; then[\s\S]*systemctl enable --now docker\.service containerd\.service[\s\S]*fi/);
    expect(source).toContain('MATRIX_TARGET_BUNDLE_SHA256={{targetBundleSha256}}');
    expect(source).toContain('target bundle provenance mismatch');
  });
});
