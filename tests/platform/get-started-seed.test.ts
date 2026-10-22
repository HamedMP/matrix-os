import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GetStartedStateSchema } from '../../packages/contracts/src/index.js';
import {
  loadCustomerVpsCloudInitTemplate,
  renderCloudInitTemplate,
} from '../../packages/platform/src/customer-vps-cloud-init.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { DEFAULT_CLOUD_INIT_TEMPLATE, buildHostConfig } from '../../packages/platform/src/customer-vps-host-config.js';

const SEED = join(process.cwd(), 'distro/customer-vps/host-bin/matrix-get-started-seed');

describe('matrix-get-started-seed', () => {
  let root: string;
  let home: string;

  function seed(target = home) {
    return spawnSync('bash', [SEED, target], { encoding: 'utf8' });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'get-started-seed-'));
    home = join(root, 'home');
    mkdirSync(home);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ships as an executable host-bin script', () => {
    expect(statSync(SEED).mode & 0o111).not.toBe(0);
  });

  it('writes a pending state into a fresh home that has no system directory yet', () => {
    const result = seed();
    expect(result.status).toBe(0);
    const statePath = join(home, 'system', 'get-started.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(GetStartedStateSchema.parse(state)).toEqual({ version: 1, status: 'pending' });
    expect(statSync(statePath).mode & 0o777).toBe(0o644);
  });

  it('never replaces an existing state file', () => {
    mkdirSync(join(home, 'system'));
    const statePath = join(home, 'system', 'get-started.json');
    writeFileSync(statePath, '{"version":1,"status":"skipped","skippedAt":"2026-10-24T00:00:00.000Z"}\n');
    expect(seed().status).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('skipped');
  });

  it('leaves no temp files behind', () => {
    seed();
    seed();
    expect(readFileSync(join(home, 'system', 'get-started.json'), 'utf8')).toContain('pending');
    const leftovers = spawnSync('ls', ['-A', join(home, 'system')], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(leftovers).toEqual(['get-started.json']);
  });

  it('refuses a symlinked system directory', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(home, 'system'));
    const result = seed();
    expect(result.status).not.toBe(0);
    expect(existsSync(join(outside, 'get-started.json'))).toBe(false);
  });

  it('refuses a missing or relative home', () => {
    expect(seed(join(root, 'missing')).status).not.toBe(0);
    expect(seed('relative/home').status).toBe(64);
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });
});

describe('matrix-restore get started seeding', () => {
  function runRestore(options: {
    vpsMeta: number;
    latestPointer: number;
    enabled?: string;
    runtimeSlot?: string;
    seedExit?: number;
  }) {
    const repo = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'restore-get-started-'));
    const matrixctl = join(dir, 'matrixctl');
    const seedStub = join(dir, 'seed');
    const seedCalls = join(dir, 'seed-calls');
    const restorePath = join(dir, 'matrix-restore.sh');
    writeFileSync(matrixctl, `#!/usr/bin/env bash
if [ "$1" = "r2" ] && [ "$2" = "exists" ]; then
  [ "$3" = "system/vps-meta.json" ] && exit ${options.vpsMeta}
  exit ${options.latestPointer}
fi
# A restore that gets past the first-install branches tries to fetch the backup.
exit 1
`, { mode: 0o755 });
    writeFileSync(seedStub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(seedCalls)}
exit ${options.seedExit ?? 0}
`, { mode: 0o755 });
    const script = readFileSync(join(repo, 'distro/customer-vps/host-bin/matrix-restore.sh'), 'utf8')
      .split('/opt/matrix/bin/matrixctl').join(matrixctl)
      .replace('get_started_seed="/opt/matrix/bin/matrix-get-started-seed"', `get_started_seed=${JSON.stringify(seedStub)}`)
      .replaceAll('mv -Tf --', 'mv -f --')
      .replace('restore_flag="/opt/matrix/restore-complete"', `restore_flag=${JSON.stringify(join(dir, 'restore-complete'))}`)
      .replace('latest_file="/var/lib/matrix/db/latest"', `latest_file=${JSON.stringify(join(dir, 'latest'))}`)
      .replace('snapshot_path="/var/lib/matrix/db/latest.dump"', `snapshot_path=${JSON.stringify(join(dir, 'latest.dump'))}`)
      .replace(
        'mkdir -p /home/matrix/home /home/matrix/projects /var/lib/matrix/db',
        `mkdir -p ${JSON.stringify(join(dir, 'home'))}`,
      );
    writeFileSync(restorePath, script, { mode: 0o755 });
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MATRIX_RUNTIME_SLOT: options.runtimeSlot ?? 'primary' };
      delete env.MATRIX_GET_STARTED_ENABLED;
      if (options.enabled !== undefined) env.MATRIX_GET_STARTED_ENABLED = options.enabled;
      const result = spawnSync('bash', [restorePath], { encoding: 'utf8', env });
      return {
        status: result.status,
        stderr: result.stderr,
        restoreComplete: existsSync(join(dir, 'restore-complete')),
        seedCalls: existsSync(seedCalls) ? readFileSync(seedCalls, 'utf8').trim().split('\n') : [],
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps both restore script copies identical', () => {
    const repo = process.cwd();
    expect(readFileSync(join(repo, 'distro/customer-vps/matrix-restore.sh'), 'utf8'))
      .toBe(readFileSync(join(repo, 'distro/customer-vps/host-bin/matrix-restore.sh'), 'utf8'));
  });

  it('seeds the owner home on a first installation when enabled', () => {
    const run = runRestore({ vpsMeta: 44, latestPointer: 44, enabled: 'true' });
    expect(run.status).toBe(0);
    expect(run.seedCalls).toEqual(['/home/matrix/home']);
    expect(run.restoreComplete).toBe(true);
  });

  it.each([
    ['flag unset', { vpsMeta: 44, latestPointer: 44 }],
    ['flag not exactly true', { vpsMeta: 44, latestPointer: 44, enabled: '1' }],
    ['a registered owner rebooting before the first backup', { vpsMeta: 0, latestPointer: 44, enabled: 'true' }],
    ['a secondary runtime slot', { vpsMeta: 44, latestPointer: 44, enabled: 'true', runtimeSlot: 'staging' }],
  ])('does not seed for %s', (_label, options) => {
    const run = runRestore(options);
    expect(run.status).toBe(0);
    expect(run.seedCalls).toEqual([]);
  });

  it('does not seed an owner who has a backup to restore', () => {
    const run = runRestore({ vpsMeta: 0, latestPointer: 0, enabled: 'true' });
    expect(run.seedCalls).toEqual([]);
  });

  it('never blocks the restore gate when seeding fails', () => {
    const run = runRestore({ vpsMeta: 44, latestPointer: 44, enabled: 'true', seedExit: 1 });
    expect(run.status).toBe(0);
    expect(run.restoreComplete).toBe(true);
    expect(run.stderr).toContain('get started seed skipped');
  });
});

describe('Get started host.env flag', () => {
  function render(template: string, enabled: string | undefined) {
    const config = loadCustomerVpsConfig({
      PLATFORM_PORT: '9000',
      PLATFORM_SECRET: 'platform-secret',
      ...(enabled === undefined ? {} : { MATRIX_GET_STARTED_ENABLED: enabled }),
    });
    const host = buildHostConfig(
      config,
      { clerkUserId: 'user_owner', handle: 'alice', runtimeSlot: 'primary', developerTools: [] },
      '00000000-0000-4000-8000-000000000635',
      'r'.repeat(64),
      '2026-10-25T01:00:00.000Z',
      'p'.repeat(48),
      { imageVersion: 'stable', hostBundleUrl: 'https://platform.example/bundle.tar.gz' } as never,
    );
    return renderCloudInitTemplate(template, host).split('\n').map((line) => line.trim());
  }

  it.each([
    ['the built-in template', async () => DEFAULT_CLOUD_INIT_TEMPLATE],
    ['the production template', () => loadCustomerVpsCloudInitTemplate()],
  ])('passes the platform flag to %s for the restore gate and gateway', async (_label, load) => {
    const template = await load();
    expect(render(template, 'true')).toContain('MATRIX_GET_STARTED_ENABLED=true');
    expect(render(template, undefined)).toContain('MATRIX_GET_STARTED_ENABLED=false');
  });
});
