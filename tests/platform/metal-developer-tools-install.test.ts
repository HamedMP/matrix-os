import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { HostdCreateVmRequest } from '@matrix-os/contracts';
import { promoteHostBundleChannel, upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { loadCustomerVpsCloudInitTemplate } from '../../packages/platform/src/customer-vps-cloud-init.js';
import type { HostdClient } from '../../packages/platform/src/substrates/hostd-client.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createMetalProvisioner } from '../../packages/platform/src/substrates/metal-provisioner.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createTestConfig } from './customer-vps-service-test-helper.js';

/**
 * A free metal VM preinstalls exactly Claude Code and Codex (spec 2691,
 * ENG-520). The golden builder's validation host.env carries
 * MATRIX_DEVELOPER_TOOLS='' and is removed by sanitize; a clone's cloud-init
 * writes its own host.env, which matrix-developer-tools.service loads. Faults
 * detected: the clone installing the golden's empty set or the default four
 * instead of the free pair, and the installer not honouring the configured list.
 */

const NOW = new Date('2026-11-21T12:00:00.000Z');
const GOLDEN = 'v2026.11.22-preview-d0730a5395e5-5-1';

function hostEnvFile(userData: string): string {
  const doc = parse(userData) as { write_files: Array<{ path: string; content: string }> };
  return doc.write_files.find((entry) => entry.path === '/opt/matrix/env/host.env')!.content;
}

describe('free metal developer tools on a clone', () => {
  let db: PlatformDB;
  let root: string;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await upsertHostBundleRelease(db, {
      version: GOLDEN, gitCommit: '1234567', buildTime: NOW.toISOString(),
      bundleKey: `system-bundles/${GOLDEN}/matrix-host-bundle.tar.gz`, checksumKey: null,
      sha256: 'd'.repeat(64), size: 100, createdAt: NOW.toISOString(),
    });
    await promoteHostBundleChannel(db, 'stable', GOLDEN, NOW.toISOString());
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    root = await mkdtemp(join(tmpdir(), 'metal-developer-tools-'));
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    await rm(root, { recursive: true, force: true });
  });

  async function renderFreeUserData(): Promise<string> {
    let userData = '';
    const client = {
      capacity: async () => ({ memoryAvailableMiB: 60_000, poolFreeBytes: 1024 ** 4, runningVms: 0, suspendedVms: 0, thinPool: { dataPercent: 20, metadataPercent: 5 } }),
      createVm: async (spec: HostdCreateVmRequest) => { userData = spec.userData; return { id: 'vm_0123456789abcdef01234567', privateIPv4: '10.78.0.14' }; },
    } as unknown as HostdClient;
    await createMetalProvisioner({
      db, hosts: createMetalHostsRepository(db.kysely), clientFor: () => client, goldenVersion: GOLDEN,
      config: createTestConfig(), cloudInitTemplate: await loadCustomerVpsCloudInitTemplate(), now: () => NOW,
      tokenFactory: () => ({ token: 'registration-token', hash: hashRegistrationToken('registration-token'), expiresAt: '2026-11-21T13:00:00.000Z' }),
      postgresPasswordFactory: () => 'postgres-secret', log: () => {},
    }).provision({ clerkUserId: 'user_khorma', handle: 'khorma38', tier: 'free' });
    return userData;
  }

  /** The installer and a fake tool pack under `root`, as matrix-developer-tools.service runs them. */
  async function installer() {
    const opt = join(root, 'opt/matrix');
    const prefix = join(opt, 'runtime/node');
    for (const dir of ['bin', 'env', 'runtime/node/bin']) await mkdir(join(opt, dir), { recursive: true });
    await mkdir(join(root, 'usr/local/bin'), { recursive: true });
    await mkdir(join(root, 'test-bin'), { recursive: true });
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(join(root, 'test-bin/zsh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const source = (await readFile('distro/customer-vps/host-bin/matrix-install-developer-tools', 'utf8'))
      .replaceAll('/opt/matrix', opt).replaceAll('/usr/local/bin', join(root, 'usr/local/bin'));
    await writeFile(join(opt, 'bin/matrix-install-developer-tools'), source, { mode: 0o755 });
    // Records each requested tool and installs a CLI at the required version.
    await writeFile(join(opt, 'bin/matrix-install-tool-pack'), `#!/bin/sh
printf '%s\\n' "$1" >> "${root}/installed-calls"
case "$1" in
  codex) printf '#!/bin/sh\\nprintf "codex-cli 0.162.1\\\\n"\\n' > "${prefix}/bin/codex"; chmod +x "${prefix}/bin/codex" ;;
  claude-code) printf '#!/bin/sh\\nprintf "2.1.280\\\\n"\\n' > "${prefix}/bin/claude"; chmod +x "${prefix}/bin/claude" ;;
  *) printf '#!/bin/sh\\n' > "${prefix}/bin/$1"; chmod +x "${prefix}/bin/$1" ;;
esac
`, { mode: 0o755 });
    return () => spawnSync('bash', [join(opt, 'bin/matrix-install-developer-tools'), '--tools-only'], {
      encoding: 'utf8', timeout: 20_000,
      // No MATRIX_DEVELOPER_TOOLS here: the script must take it from host.env, as the unit does.
      env: { PATH: `${join(root, 'test-bin')}:/usr/bin:/bin`, HOME: join(root, 'home'), MATRIX_NODE_PREFIX: prefix,
        MATRIX_DEVELOPER_TOOLS_STATE_DIR: join(root, 'state'), MATRIX_RUNTIME_USER: userInfo().username },
    });
  }

  async function calls(): Promise<string[]> {
    return (await readFile(join(root, 'installed-calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  }

  it('the golden validation host.env installs nothing, and sanitize removes it before cloning', async () => {
    const run = await installer();
    // matrix-golden-snapshot-activate writes this for validation inside the builder.
    await writeFile(join(root, 'opt/matrix/env/host.env'), "MATRIX_DEVELOPER_TOOLS=''\n");
    expect(run().status).toBe(0);
    expect(await calls()).toEqual([]);
    expect(await readFile('distro/customer-vps/host-bin/matrix-golden-snapshot-activate', 'utf8')).toContain("MATRIX_DEVELOPER_TOOLS=''");
    expect(await readFile('distro/customer-vps/host-bin/matrix-golden-snapshot-sanitize', 'utf8')).toMatch(/^\s*opt\/matrix\/env$/m);
  });

  it('a clone installs exactly Claude Code and Codex from the host.env cloud-init writes', async () => {
    const run = await installer();
    await writeFile(join(root, 'opt/matrix/env/host.env'), "MATRIX_DEVELOPER_TOOLS=''\n");
    // Cloud-init write_files replaces the file on the clone's first boot.
    // Relocated under the test root like the script itself (host.env names the node prefix).
    await writeFile(join(root, 'opt/matrix/env/host.env'),
      hostEnvFile(await renderFreeUserData()).replaceAll('/opt/matrix', join(root, 'opt/matrix')));

    const result = run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await calls()).toEqual(['codex', 'claude-code']);
    expect((await readFile(join(root, 'state/installed-tools'), 'utf8')).split('\n').filter(Boolean)).toEqual(['codex', 'claude-code']);
  });
});
