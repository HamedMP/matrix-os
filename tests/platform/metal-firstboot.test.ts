import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { HostdCreateVmRequest } from '@matrix-os/contracts';
import { promoteHostBundleChannel, upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { loadCustomerVpsCloudInitTemplate } from '../../packages/platform/src/customer-vps-cloud-init.js';
import { createConfiguredInternalSyncRoutes } from '../../packages/platform/src/internal-sync-routes.js';
import { createApp } from '../../packages/platform/src/main.js';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';
import type { HostdClient } from '../../packages/platform/src/substrates/hostd-client.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createMetalProvisioner } from '../../packages/platform/src/substrates/metal-provisioner.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createTestConfig } from './customer-vps-service-test-helper.js';

/**
 * First boot of a free metal VM (spec 2691, ENG-520), from the user data the
 * real provisioner renders to the guest's first platform calls. Faults
 * detected: a VM cloned from a golden disk running the full clean-image
 * install (bundle re-download, apt) because its user data does not name the
 * golden as its snapshot source; and the guest's restore check being refused
 * with 401 on a platform without owner sync storage, which aborts cloud-init
 * before the guest ever registers.
 */

const execFileAsync = promisify(execFile);
const fastPathScript = 'distro/customer-vps/host-bin/matrix-golden-snapshot-fast-path';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const MACHINE_ID = '6a0c4f8e-3b1d-4f2a-9c7e-1d2b3c4d5e6f';
// METAL_GOLDEN_VERSION is the bundle version the golden disk was built from
// (distro/metal-host/build-golden-disk.sh names the LV golden-<bundle-version>).
const GOLDEN = 'v2026.11.22-preview-7b8ad40e29f2-1-1';
const GOLDEN_SHA = 'd'.repeat(64);
const CHANNEL_VERSION = 'v2026.11.20-1';

async function registerRelease(db: PlatformDB, version: string, sha256: string) {
  await upsertHostBundleRelease(db, {
    version, gitCommit: '1234567', buildTime: NOW.toISOString(),
    bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, checksumKey: null,
    sha256, size: 100, createdAt: NOW.toISOString(),
  });
}

/** The host.env a guest gets from cloud-init, as written to /opt/matrix/env/host.env. */
function hostEnvFile(userData: string): string {
  const doc = parse(userData) as { write_files: Array<{ path: string; content: string }> };
  const file = doc.write_files.find((entry) => entry.path === '/opt/matrix/env/host.env');
  if (!file) throw new Error('user data has no host.env');
  return file.content;
}

function hostEnv(userData: string): Record<string, string> {
  return Object.fromEntries(hostEnvFile(userData).split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

describe('metal VM first boot', () => {
  let db: PlatformDB;
  let userData: string;
  const roots: string[] = [];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await registerRelease(db, CHANNEL_VERSION, 'c'.repeat(64));
    await promoteHostBundleChannel(db, 'stable', CHANNEL_VERSION, NOW.toISOString());
    await registerRelease(db, GOLDEN, GOLDEN_SHA);
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    userData = '';
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function provision(configOverrides: Partial<ReturnType<typeof createTestConfig>> = {}) {
    const client = {
      capacity: async () => ({ memoryAvailableMiB: 60_000, poolFreeBytes: 1024 ** 4, runningVms: 0, suspendedVms: 0, thinPool: { dataPercent: 20, metadataPercent: 5 } }),
      createVm: async (spec: HostdCreateVmRequest) => {
        userData = spec.userData;
        return { id: 'vm_0123456789abcdef01234567', privateIPv4: '10.78.0.14' };
      },
    } as unknown as HostdClient;
    const config = createTestConfig(configOverrides);
    const result = await createMetalProvisioner({
      db, hosts: createMetalHostsRepository(db.kysely), clientFor: () => client, goldenVersion: GOLDEN, config,
      cloudInitTemplate: await loadCustomerVpsCloudInitTemplate(), now: () => NOW, sleep: async () => undefined,
      machineIdFactory: () => MACHINE_ID,
      tokenFactory: () => ({ token: 'registration-token', hash: hashRegistrationToken('registration-token'), expiresAt: '2026-11-21T13:00:00.000Z' }),
      postgresPasswordFactory: () => 'postgres-secret', log: () => {},
    }).provision({ clerkUserId: 'user_khorma', handle: 'khorma38', tier: 'free' });
    expect(result).toEqual({ machineId: MACHINE_ID });
    return config;
  }

  /** The evidence build-golden-disk.sh validates on the sealed golden disk before marking it read-only. */
  async function goldenDiskRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'matrix-metal-golden-'));
    roots.push(root);
    await mkdir(join(root, 'opt/matrix/app'), { recursive: true });
    await mkdir(join(root, 'opt/matrix/env'), { recursive: true });
    await writeFile(join(root, 'opt/matrix/golden-snapshot-system-ready'), 'matrix-host-prerequisites-v1\n');
    await writeFile(join(root, 'opt/matrix/HOST_PREREQUISITES_READY'), 'version=1\n');
    await writeFile(join(root, 'opt/matrix/app/BUNDLE_VERSION'), `${GOLDEN}\n`);
    await writeFile(join(root, 'opt/matrix/app/BUNDLE_SHA256'), `${GOLDEN_SHA}\n`);
    return root;
  }

  it('takes the golden fast path on a VM cloned from the golden disk', async () => {
    await provision();
    const root = await goldenDiskRoot();
    await writeFile(join(root, 'opt/matrix/env/host.env'), hostEnvFile(userData));
    await chmod(fastPathScript, 0o755);

    // Cloud-init's runcmd asks this script whether to skip the clean-image install.
    await expect(execFileAsync(fastPathScript, [], { env: { PATH: process.env.PATH, MATRIX_GOLDEN_SNAPSHOT_ROOT: root } }))
      .resolves.toMatchObject({ stdout: '' });
    const env = hostEnv(userData);
    expect(env).toMatchObject({
      MATRIX_IMAGE_SOURCE: 'snapshot',
      MATRIX_IMAGE_VERSION: GOLDEN,
      MATRIX_SNAPSHOT_SOURCE_VERSION: GOLDEN,
      MATRIX_TARGET_BUNDLE_SHA256: GOLDEN_SHA,
    });
    // The clean-image fallback, if a clone ever lacks the evidence, fetches the same bundle.
    expect(env.MATRIX_HOST_BUNDLE_URL).toContain(`/system-bundles/${GOLDEN}/`);
  });

  it('does not depend on a release channel: a preview platform on the empty dev channel still pins the golden bundle', async () => {
    await provision({ imageVersion: 'dev' });

    expect(hostEnv(userData)).toMatchObject({ MATRIX_IMAGE_VERSION: GOLDEN, MATRIX_TARGET_BUNDLE_SHA256: GOLDEN_SHA });
  });

  describe('restore check', () => {
    function orchestrator(): Orchestrator {
      return { listAll: vi.fn().mockReturnValue([]) } as unknown as Orchestrator;
    }

    async function restoreProbe(config: ReturnType<typeof createTestConfig>, env: NodeJS.ProcessEnv, token?: string) {
      const guest = hostEnv(userData);
      const internalSyncRoutes = createConfiguredInternalSyncRoutes({
        db, r2: null, platformSecret: config.platformSecret, r2PrefixRoot: 'matrixos-sync', env,
      });
      const app = createApp({ db, orchestrator: orchestrator(), platformSecret: config.platformSecret, internalSyncRoutes });
      // What matrix-r2-broker.mjs sends for `matrixctl r2 exists <key>` during matrix-restore.
      const probe = (key: string) => app.request(`/internal/containers/${guest.MATRIX_HANDLE}/sync/system/exists`, {
        method: 'POST',
        headers: {
          'x-matrix-machine-id': guest.MATRIX_MACHINE_ID!,
          'x-matrix-runtime-slot': guest.MATRIX_RUNTIME_SLOT!,
          authorization: `Bearer ${token ?? guest.MATRIX_SYNC_RUNTIME_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ key }),
      });
      return probe;
    }

    it('tells a new owner on a preview platform without sync storage that no backup exists', async () => {
      const config = await provision();
      const probe = await restoreProbe(config, { PLATFORM_PREVIEW: 'true' });

      for (const key of ['system/vps-meta.json', 'system/db/latest']) {
        const res = await probe(key);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ exists: false });
      }
    });

    it('still authenticates the guest when sync storage is absent', async () => {
      const config = await provision();
      const probe = await restoreProbe(config, { PLATFORM_PREVIEW: 'true' }, 'f'.repeat(64));

      expect((await probe('system/db/latest')).status).toBe(401);
    });

    it('fails closed on a preview that can provision Hetzner VPSes, whose owners may have backups elsewhere', async () => {
      const config = await provision();
      const probe = await restoreProbe(config, { PLATFORM_PREVIEW: 'true', HETZNER_API_TOKEN: 'hetzner-token' });

      const res = await probe('system/vps-meta.json');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Sync storage unavailable' });
    });

    it('fails closed with a storage error, not an auth error, outside previews', async () => {
      const config = await provision();
      const probe = await restoreProbe(config, {});

      const res = await probe('system/db/latest');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Sync storage unavailable' });
    });
  });
});
