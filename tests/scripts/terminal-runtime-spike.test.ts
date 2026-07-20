import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  MAX_EVIDENCE_FILE_BYTES,
  reportGateChecks,
  validateEvidenceDirectory,
} from '../../scripts/spikes/terminal-runtime/verify-evidence.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const s1Checks = {
  keeperMainPid: true,
  runtimeCgroupMembers: true,
  gatewayOutsideCgroup: true,
  attachOutsideCgroup: true,
  detachPreservesPids: true,
  gatewayRestartPreservesPids: true,
  gatewayCrashPreservesPids: true,
  shellRestartPreservesPids: true,
  stopEmptiesCgroup: true,
  keeperLossDeterministic: true,
  serverLossDeterministic: true,
  readinessGated: true,
  layeredMemoryHigh: true,
};

const s2Checks = {
  exactOptionSyntax: true,
  cacheMappedByRuntime: true,
  layoutRestored: true,
  viewportRestored: true,
  scrollbackBounded: true,
  lossWindowBounded: true,
  commandsConfirmationGated: true,
  forceRunAbsent: true,
  corruptionFallback: true,
  deletionComplete: true,
  diskAccountingBounded: true,
  liveSerializationDisableSafe: true,
};

async function evidence(overrides: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-evidence-'));
  roots.push(root);
  await mkdir(join(root, 's1'));
  const body = `${JSON.stringify({
    role: 'keeper',
    pid: 4201,
    cgroup: '/matrix-terminal.slice/matrix-terminal-spike.slice/runtime.scope',
  })}\n`;
  await writeFile(join(root, 's1', 'processes.json'), body, 'utf8');
  const file = {
    path: 's1/processes.json',
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  const summary = {
    schemaVersion: 1,
    prHeadSha: 'a'.repeat(40),
    zellijVersion: 'zellij 0.44.1',
    ubuntuVersion: '24.04',
    systemdVersion: '255',
    kernelVersion: '6.8.0-probe',
    s1: { status: 'pass', checks: s1Checks },
    s2: { status: 'pass', checks: s2Checks },
    privacyScan: { status: 'pass', findings: 0 },
    files: [file],
    totalBytes: file.bytes,
    ...overrides,
  };
  await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return root;
}

describe('terminal runtime spike evidence', () => {
  it('runs from a labeled same-repository PR before manual dispatch is available', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github/workflows/terminal-runtime-spikes.yml'),
      'utf8',
    );

    expect(workflow).toContain('pull_request:\n    types: [labeled, synchronize, reopened]');
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("contains(github.event.pull_request.labels.*.name, 'preview-vps')");
    expect(workflow).toContain('PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr }}');
    expect(workflow).toContain('deadline=$((SECONDS + 1500))');
    expect(workflow).toContain("runtime_version=\"$(jq -r '.runtimeVersion // \"\"' <<<\"$machine\")\"");
    expect(workflow).not.toContain("jq -r '.imageVersion // \"\"'");
    expect(workflow).toContain('--resolve "app.matrix-os.com:443:${PUBLIC_IPV4}"');
    expect(workflow).toContain("'https://app.matrix-os.com/api/terminal/run'");
    expect(workflow.match(/--insecure/g)).toHaveLength(2);
    expect(workflow).toContain('PLATFORM_SECRET never leaves the runner');
    expect(workflow.match(/gateway_http_status=\$http_code/g)).toHaveLength(2);
    expect(workflow).not.toContain('VPS_SSH_KEY');
    expect(workflow).toContain('workflow_dispatch:');
  });

  it('packages the harness only for explicitly marked preview bundles', async () => {
    const [buildScript, previewWorkflow] = await Promise.all([
      readFile(join(process.cwd(), 'scripts/build-host-bundle.sh'), 'utf8'),
      readFile(join(process.cwd(), '.github/workflows/preview-vps.yml'), 'utf8'),
    ]);

    expect(previewWorkflow).toContain("MATRIX_TERMINAL_RUNTIME_SPIKE: '1'");
    expect(buildScript).toContain('if [ "${MATRIX_TERMINAL_RUNTIME_SPIKE:-0}" = "1" ]; then');
    expect(buildScript).toContain('scripts/spikes/terminal-runtime');
  });

  it('detaches the spike from the gateway cgroup and waits for completed evidence', async () => {
    const [workflow, launcher, packer, runner] = await Promise.all([
      readFile(join(process.cwd(), '.github/workflows/terminal-runtime-spikes.yml'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/launch-remote.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/pack-evidence.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/run-remote.sh'), 'utf8'),
    ]);

    expect(workflow).toContain('/opt/matrix/app/scripts/spikes/terminal-runtime/launch-remote.sh');
    expect(workflow).toContain('evidence_deadline=$((SECONDS + 2100))');
    expect(workflow).toContain('"$EVIDENCE" --report-gates');
    expect(workflow).not.toContain('REMOTE_STATUS:');
    expect(launcher).toContain('systemd-run');
    expect(launcher).toContain('--collect');
    expect(launcher).toContain('--no-block');
    expect(launcher).toContain('StandardOutput=null');
    expect(launcher).toContain('StandardError=null');
    expect(packer).toContain('summary.json');
    expect(packer).toContain('spike_pack_evidence_incomplete');
    expect(runner).toContain('base_id="1${pr_head_sha:0:31}"');
    expect(runner).toContain('zellij delete-session "matrix-t-${runtime_id}" --force');
    expect(runner).toContain('attach-probe.mjs');
    expect(runner).not.toContain('script -qefc');
    expect(runner).toContain('cgroup_removed');
    expect(runner).toContain("grep -Fq '<ENTER> run'");
    expect(runner).toContain('action write --pane-id "$pane_id" 13');
    expect(runner).toContain('console.log(p.id)');
    expect(runner).toContain('pkill -f -x');
    expect(runner).toContain('for runtime_id in "${memory_ids[@]}"; do');
    expect(runner).toContain('slice_current=');
    expect(runner).toContain('wait_file');
  });

  it('keeps the fixed notify unit shape and accepts readiness from the keeper helper', async () => {
    const [unit, keeper] = await Promise.all([
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/matrix-terminal-spike@.service'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/keeper.mjs'), 'utf8'),
    ]);

    expect(unit).toContain('Type=notify\nNotifyAccess=all\n');
    expect(unit).toContain('ExecStart=/opt/matrix/runtime/node/bin/node /opt/matrix/libexec/terminal-runtime-spike/keeper.mjs %i');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('Restart=no');
    expect(unit).not.toContain('EnvironmentFile=');
    expect(unit).not.toContain('[Install]');
    expect(keeper).toContain("!process.cmdline.includes('list-sessions')");
  });

  it('accepts complete bounded S1 and S2 evidence', async () => {
    const root = await evidence();

    await expect(validateEvidenceDirectory(root)).resolves.toMatchObject({
      prHeadSha: 'a'.repeat(40),
      s1: { status: 'pass' },
      s2: { status: 'pass' },
      fileCount: 1,
    });
  });

  it('rejects a missing or failed mandatory check', async () => {
    const root = await evidence({
      s1: {
        status: 'fail',
        checks: { ...s1Checks, stopEmptiesCgroup: false },
      },
    });

    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_gate_failed');
  });

  it('reports only allowlisted gate names for rejected evidence', async () => {
    const root = await evidence({
      s1: {
        status: 'fail',
        checks: { ...s1Checks, stopEmptiesCgroup: false, injectedSecret: 'do-not-log' },
      },
    });
    await writeFile(
      join(root, 's1', 'base-startup-failure.json'),
      `${JSON.stringify({ stage: 'readiness', code: 'client_exit', exitCode: 1, signal: 0 })}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 's1', 'base-startup-unit.txt'),
      'ActiveState=failed\nSubState=failed\nResult=timeout\nExecMainCode=1\nExecMainStatus=16\n',
      'utf8',
    );
    await writeFile(
      join(root, 's1', 'base-runtime-roles.json'),
      `${JSON.stringify({
        checkpoint: 'initial', keeper: true, zellijAlive: 1,
        zellijExpected: 2, shell: true, agent: false,
      })}\n`,
      'utf8',
    );
    await mkdir(join(root, 's2'));
    await writeFile(
      join(root, 's2', 'recovery-startup-failure.json'),
      `${JSON.stringify({ stage: 'readiness', code: 'readiness_timeout' })}\n`,
      'utf8',
    );
    await writeFile(join(root, 's1', 'memory-stage.txt'), 'slice_no_pressure unit=2 slice=0 current=3 high=4 hogs=3\n', 'utf8');

    await expect(reportGateChecks(root)).resolves.toEqual([
      's1:stopEmptiesCgroup=fail',
      's1:startup=readiness/client_exit',
      's1:pty-exit=1/0',
      's1:unit=failed/failed/timeout/1/16',
      's1:roles=initial/keeper:1/zellij:1of2/shell:1/agent:0',
      's2:recovery=readiness/readiness_timeout',
      's1:memory=slice_no_pressure/unit:2/slice:0/current:3/high:4/hogs:3',
    ]);
    await rm(join(root, 's1', 'base-runtime-roles.json'));
    await symlink('/etc/passwd', join(root, 's1', 'base-runtime-roles.json'));
    await expect(reportGateChecks(root)).resolves.toEqual([
      's1:stopEmptiesCgroup=fail', 's1:startup=readiness/client_exit',
      's1:pty-exit=1/0', 's1:unit=failed/failed/timeout/1/16',
      's2:recovery=readiness/readiness_timeout',
      's1:memory=slice_no_pressure/unit:2/slice:0/current:3/high:4/hogs:3',
    ]);
  });

  it('rejects a binary other than the exact bundled Zellij 0.44.1', async () => {
    const root = await evidence({ zellijVersion: 'zellij 0.44.3' });

    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_zellij_version');
  });

  it('rejects traversal and symlink evidence entries', async () => {
    const traversalRoot = await evidence({
      files: [{ path: '../outside', bytes: 1, sha256: '0'.repeat(64) }],
      totalBytes: 1,
    });
    await expect(validateEvidenceDirectory(traversalRoot)).rejects.toThrow('evidence_file_path');

    const symlinkRoot = await evidence();
    await rm(join(symlinkRoot, 's1', 'processes.json'));
    await symlink('/etc/passwd', join(symlinkRoot, 's1', 'processes.json'));
    await expect(validateEvidenceDirectory(symlinkRoot)).rejects.toThrow('evidence_file_type');
  });

  it('rejects hard-linked and unlisted evidence files', async () => {
    const hardLinkRoot = await evidence();
    await link(
      join(hardLinkRoot, 's1', 'processes.json'),
      join(hardLinkRoot, 's1', 'processes-hard-link.json'),
    );
    await expect(validateEvidenceDirectory(hardLinkRoot)).rejects.toThrow('evidence_file_type');

    const unlistedRoot = await evidence();
    await writeFile(join(unlistedRoot, 'unlisted.txt'), 'unexpected\n', 'utf8');
    await expect(validateEvidenceDirectory(unlistedRoot)).rejects.toThrow('evidence_unlisted_file');
  });

  it('rejects oversized files before reading their contents', async () => {
    const root = await evidence();
    const body = 'x'.repeat(MAX_EVIDENCE_FILE_BYTES + 1);
    await writeFile(join(root, 's1', 'processes.json'), body, 'utf8');

    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_file_size');
  });

  it.each([
    'authorization: Bearer abcdef',
    'token=super-secret-value',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'host=203.0.113.10',
    'cwd=/home/matrix/home/projects/private',
  ])('rejects sensitive evidence content: %s', async (secret) => {
    const root = await evidence();
    const body = `${secret}\n`;
    await writeFile(join(root, 's1', 'processes.json'), body, 'utf8');
    const summaryPath = join(root, 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    summary.files[0] = {
      path: 's1/processes.json',
      bytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    summary.totalBytes = Buffer.byteLength(body);
    await writeFile(summaryPath, `${JSON.stringify(summary)}\n`, 'utf8');

    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_privacy');
  });

  it('rejects digest and declared-size mismatches', async () => {
    const root = await evidence();
    await writeFile(join(root, 's1', 'processes.json'), '{}\n', 'utf8');

    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_file_metadata');
  });
});
