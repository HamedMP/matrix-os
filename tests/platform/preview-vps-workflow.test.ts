import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = process.cwd();
const waitScript = join(root, 'scripts/wait-preview-provisioning.sh');
const tempDirectories: string[] = [];
const machineId = '30000000-0000-4000-8000-000000000001';

async function runWaitScript(machine: Record<string, unknown>, overrides: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'matrix-preview-wait-'));
  tempDirectories.push(directory);
  const curlPath = join(directory, 'curl');
  const jqPath = join(directory, 'jq');
  await writeFile(curlPath, `#!/usr/bin/env node
const fs = require('node:fs');

const statePath = process.env.FAKE_CURL_STATE;
const statusCodes = (process.env.FAKE_HTTP_CODES ?? '200').split(',');
let invocation = 0;
try {
  invocation = Number(fs.readFileSync(statePath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
fs.writeFileSync(statePath, String(invocation + 1));
const statusCode = statusCodes[Math.min(invocation, statusCodes.length - 1)];
const body = statusCode === '200'
  ? process.env.FAKE_FLEET_RESPONSE
  : process.env.FAKE_ERROR_RESPONSE;
process.stdout.write(body + '\\n' + statusCode);
`);
  await writeFile(jqPath, `#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8').trim();

function readArg(name) {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === '--arg' && args[index + 1] === name) {
      return args[index + 2];
    }
  }
  return undefined;
}

if (args.includes('-c')) {
  const payload = JSON.parse(input);
  const handle = readArg('h');
  const machineId = readArg('id');
  const machine = payload.machines.find((candidate) =>
    candidate.handle === handle && candidate.machineId === machineId && candidate.deletedAt == null
  ) ?? { status: 'absent', failureCode: null };
  process.stdout.write(JSON.stringify(machine) + '\\n');
} else if (args.includes('-r')) {
  const payload = JSON.parse(input);
  const expression = args[args.length - 1];
  if (expression.includes('.status')) {
    process.stdout.write(String(payload.status) + '\\n');
  } else if (expression.includes('.failureCode')) {
    process.stdout.write(String(payload.failureCode ?? 'unknown') + '\\n');
  } else {
    process.exit(2);
  }
} else {
  process.exit(2);
}
`);
  await chmod(curlPath, 0o755);
  await chmod(jqPath, 0o755);

  return spawnSync('bash', [waitScript], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      PLATFORM_PUBLIC_URL: 'https://platform.example',
      PLATFORM_SECRET: 'platform-secret',
      HANDLE: 'pr-1340',
      PREVIEW_MACHINE_ID: machineId,
      PREVIEW_PROVISION_TIMEOUT_SECONDS: '5',
      PREVIEW_PROVISION_POLL_SECONDS: '0',
      FAKE_FLEET_RESPONSE: JSON.stringify({ machines: [machine] }),
      FAKE_ERROR_RESPONSE: 'provider throttling details must stay private',
      FAKE_HTTP_CODES: '200',
      FAKE_CURL_STATE: join(directory, 'curl-state'),
      ...overrides,
    },
  });
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Preview VPS provisioning workflow', () => {
  it('collects bounded updater diagnostics before an install timeout', () => {
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');
    const deployStep = YAML.parse(workflow).jobs.deploy.steps.find(
      (step: { name?: string }) => step.name === 'Deploy preview bundle to preview VPS',
    ).run as string;

    expect(deployStep).toContain('collect_preview_diagnostics()');
    expect(deployStep).toContain('"/opt/matrix/app/.update-error.json"');
    expect(deployStep).toContain('metadata.st_size > limit');
    expect(deployStep).toContain('state["updateError"]');
    expect(deployStep).toContain('state["updateVersion"]');
    expect(deployStep).not.toContain('/usr/bin/journalctl');
    expect(deployStep).toContain('collect_preview_diagnostics || true');
    expect(deployStep.indexOf('collect_preview_diagnostics || true'))
      .toBeLessThan(deployStep.indexOf('Timed out waiting for ${HANDLE}'));
  });

  it('budgets the job for provisioning, bounded repair, and workflow overhead', () => {
    const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8'));
    const deploy = workflow.jobs.deploy;
    const checkoutSteps = deploy.steps.filter((step: { uses?: string }) => step.uses === 'actions/checkout@v6');
    const provisionSeconds = Number(deploy.env.PREVIEW_PROVISION_TIMEOUT_SECONDS);
    const installSeconds = Number(deploy.env.PREVIEW_INSTALL_TIMEOUT_SECONDS);
    const workflowOverheadSeconds = 15 * 60;

    expect(deploy['timeout-minutes'] * 60)
      .toBeGreaterThanOrEqual(provisionSeconds + (2 * installSeconds) + workflowOverheadSeconds);
    expect(checkoutSteps).toEqual([
      expect.objectContaining({
        if: "needs.gate.outputs.action == 'deploy'",
        with: { ref: '${{ needs.gate.outputs.head_sha }}' },
      }),
      expect.objectContaining({
        if: "needs.gate.outputs.action == 'deploy_existing'",
        with: { ref: 'main' },
      }),
    ]);
    expect(workflow.jobs.gate.steps.find((step: { name?: string }) => step.name === 'Decide action').run)
      .toContain('[ "$GITHUB_REF" != "refs/heads/main" ]');
    expect(deploy.steps.find((step: { name?: string }) => step.name === 'Provision or resume preview VPS').run)
      .toContain('PREVIEW_MACHINE_ID="$accepted_machine_id" ./scripts/wait-preview-provisioning.sh');
  });

  it('can smoke-test the exact current dev release from a healthy stable baseline', () => {
    const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8'));
    const decide = workflow.jobs.gate.steps.find((step: { name?: string }) => step.name === 'Decide action').run as string;
    const deploy = workflow.jobs.deploy.steps.find(
      (step: { name?: string }) => step.name === 'Deploy preview bundle to preview VPS',
    ).run as string;

    expect(workflow.on.workflow_dispatch.inputs.release_smoke).toEqual(expect.objectContaining({
      type: 'boolean',
      default: false,
    }));
    expect(workflow.on.workflow_dispatch.inputs.diagnose_smoke).toEqual(expect.objectContaining({
      type: 'boolean',
      default: false,
    }));
    expect(decide).toContain('RELEASE_SMOKE');
    expect(decide).toContain('/system-bundles/channels/dev.json');
    expect(decide).toContain('Requested release is not the current dev bundle');
    expect(deploy).toContain('Stable baseline ready for ${HANDLE}: ${stable_version}');
    expect(deploy).toContain('wait_for_stable_host_settled()');
    expect(deploy).toContain('apt-daily-upgrade.service');
    expect(deploy).not.toContain('"unattended-upgr"');
    expect(deploy).toContain('Draining pending Ubuntu package maintenance before the release smoke test.');
    expect(deploy).toContain('systemctl","start","--no-block","apt-daily-upgrade.service');
    expect(deploy).toContain('consecutive_idle');
    expect(deploy).toContain('deadline=$((SECONDS + 600))');
    expect(deploy).toContain('Stable host provisioning is settled');
    expect(deploy.indexOf('Stable host provisioning is settled'))
      .toBeLessThan(deploy.indexOf('seed_legacy_sessions'));
    expect(deploy).toContain('verify_terminal_migration()');
    expect(deploy).toContain('journalStatus');
    expect(deploy).toContain('stateSchemaVersion');
    expect(deploy).toContain('activeWorkspaceServices');
    expect(deploy).toContain('Terminal migration verified');
    expect(workflow.jobs.diagnose_release.if).toContain("needs.gate.outputs.action == 'diagnose'");
    const diagnose = workflow.jobs.diagnose_release.steps[1].run as string;
    expect(diagnose).toContain('gatewayLifecycle');
    expect(diagnose).toContain('gatewayExitFingerprints');
    expect(diagnose).toContain('syncAgentLifecycle');
    expect(diagnose).toContain('privilegedGatewayActions');
    expect(diagnose).toContain('terminalMigration');
    expect(diagnose).toContain('hostServiceState');
    expect(diagnose).toContain('hostActorWindows');
    expect(diagnose).toContain('hostManagerLifecycle');
    expect(diagnose).toContain('maintenanceLifecycle');
    expect(diagnose).toContain('bootIdCount');
    expect(diagnose).toContain('apt-daily-upgrade.service');
    expect(diagnose).toContain('gzip -c | base64 -w0');
    expect(diagnose).toContain('"${#diagnostic_payload}" -gt 4096');
    expect(diagnose).toContain('gzip.decompress(base64.b64decode(sys.argv[1]))');

    const shellSyntax = spawnSync('bash', ['-n', '-c', deploy], { encoding: 'utf8' });
    expect(shellSyntax.stderr).toBe('');
    expect(shellSyntax.status).toBe(0);
    const pythonBlocks = [...deploy.matchAll(/<<'PYTHON'[^\n]*\n([\s\S]*?)\nPYTHON/g)];
    expect(pythonBlocks.length).toBeGreaterThanOrEqual(4);
    for (const [, source] of pythonBlocks) {
      const pythonSyntax = spawnSync('python3', [
        '-c',
        'import sys; compile(sys.argv[1], "preview-vps-inline", "exec")',
        source!,
      ], { encoding: 'utf8' });
      expect(pythonSyntax.stderr).toBe('');
      expect(pythonSyntax.status).toBe(0);
    }
    const diagnosticPythonBlocks = [...diagnose.matchAll(/<<'PYTHON'[^\n]*\n([\s\S]*?)\nPYTHON/g)];
    expect(diagnosticPythonBlocks).toHaveLength(2);
    for (const [, source] of diagnosticPythonBlocks) {
      const pythonSyntax = spawnSync('python3', [
        '-c',
        'import sys; compile(sys.argv[1], "preview-vps-diagnostic-inline", "exec")',
        source!,
      ], { encoding: 'utf8' });
      expect(pythonSyntax.stderr).toBe('');
      expect(pythonSyntax.status).toBe(0);
    }
  });

  it('restricts the real-customer release smoke to nimanaderi and the pinned release', () => {
    const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8'));
    const decide = workflow.jobs.gate.steps.find((step: { name?: string }) => step.name === 'Decide action').run as string;
    const smoke = workflow.jobs.customer_release_smoke.steps.find(
      (step: { name?: string }) => step.name === 'Verify stable, deploy, and prove the new terminal architecture',
    ).run as string;

    expect(workflow.on.workflow_dispatch.inputs.customer_release_smoke).toEqual(expect.objectContaining({
      type: 'boolean',
      default: false,
    }));
    expect(decide).toContain('action="customer_smoke"');
    expect(decide).toContain('handle="nimanaderi"');
    expect(decide).toContain('refs/heads/release-smoke-vps');
    expect(decide).toContain('v2026.09.12-1239');
    expect(workflow.jobs.customer_release_smoke.if).toContain("needs.gate.outputs.action == 'customer_smoke'");
    expect(smoke).toContain('Source preflight verified');
    expect(smoke).toContain('"coreServicesActive": all(services[name] for name in core_service_names)');
    expect(smoke).toContain('.coreServicesActive == true');
    expect(smoke).toContain('.terminalRuntimeActive == true');
    expect(smoke).toContain('/vps/deploy');
    expect(smoke).toContain('deploy_body="{\\"version\\":\\"${VERSION}\\",\\"handle\\":\\"${HANDLE}\\"}"');
    expect(smoke).toContain('/api/terminal/workspaces/ensure');
    expect(smoke).toContain('Matrix terminal smoke');
    expect(smoke).toContain('binary-input-v1');
    expect(smoke).toContain('__MATRIX_OSC_OK__');
    expect(smoke).toContain('osc_feedback_loop_detected');
    expect(smoke).toContain('keyboardRoundTrips: 2');
    expect(smoke).toContain('content = "".join(sys.argv[2:])');
    expect(smoke).toContain('[range(0; length; 3000) as $offset | .[$offset:$offset + 3000]]');
    expect(smoke).not.toContain('["/opt/matrix/runtime/node/bin/node","-e",$script');
    expect(smoke).toContain('delete_exact_test_workspace "$workspace_id"');
    expect(smoke).toContain('Temporary terminal workspace removed by exact ID.');
    expect(smoke).toContain('Terminal architecture verified');
    expect(smoke).toContain('Migration remained committed after the observation window');
    expect(smoke).not.toContain('MATRIX_AUTH_TOKEN');

    const shellSyntax = spawnSync('bash', ['-n', '-c', smoke], { encoding: 'utf8' });
    expect(shellSyntax.stderr).toBe('');
    expect(shellSyntax.status).toBe(0);
  });

  it('returns successfully when the accepted machine is running', async () => {
    const result = await runWaitScript({
      handle: 'pr-1340',
      machineId,
      status: 'running',
      failureCode: null,
      deletedAt: null,
    });

    expect(result.status).toBe(0);
  });

  it('backs off and recovers from a transient fleet rate limit', async () => {
    const result = await runWaitScript({
      handle: 'pr-1340',
      machineId,
      status: 'running',
      failureCode: null,
      deletedAt: null,
    }, { FAKE_HTTP_CODES: '429,200' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Preview fleet status is throttled; retrying');
    expect(result.stderr).not.toContain('provider throttling details');
  });

  it('reports a coarse terminal failure code', async () => {
    const result = await runWaitScript({
      handle: 'pr-1340',
      machineId,
      status: 'failed',
      failureCode: 'registration_timeout',
      deletedAt: null,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('code: registration_timeout');
  });

  it('replaces malformed failure codes and bounds the wait', async () => {
    const malformed = await runWaitScript({
      handle: 'pr-1340',
      machineId,
      status: 'failed',
      failureCode: 'provider secret: do not print',
      deletedAt: null,
    });
    const timedOut = await runWaitScript({
      handle: 'pr-1340',
      machineId,
      status: 'provisioning',
      failureCode: null,
      deletedAt: null,
    }, { PREVIEW_PROVISION_TIMEOUT_SECONDS: '0' });

    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('code: unknown');
    expect(malformed.stderr).not.toContain('provider secret');
    expect(timedOut.status).toBe(1);
    expect(timedOut.stderr).toContain('Timed out waiting for pr-1340');
  });
});
