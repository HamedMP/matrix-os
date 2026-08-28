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
  await writeFile(curlPath, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$FAKE_FLEET_RESPONSE"\n');
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
      ...overrides,
    },
  });
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Preview VPS provisioning workflow', () => {
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
