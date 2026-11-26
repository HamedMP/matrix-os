import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostdCapacityResponse, HostdCreateVmRequest } from '@matrix-os/contracts';
import { sql, type KyselyPlugin, type QueryId } from 'kysely';
import {
  getActiveUserMachineByClerkId,
  getUserMachine,
  insertUserMachine,
  promoteHostBundleChannel,
  upsertHostBundleRelease,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { loadCustomerVpsCloudInitTemplate } from '../../packages/platform/src/customer-vps-cloud-init.js';
import { HostdError, type HostdClient } from '../../packages/platform/src/substrates/hostd-client.js';
import {
  createMetalHostsRepository,
  type MetalHost,
  type MetalHostInput,
} from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createMetalProvisioner } from '../../packages/platform/src/substrates/metal-provisioner.js';
import { createMetalVmDeletionDrainer } from '../../packages/platform/src/substrates/metal-vm-deletions.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createTestConfig } from './customer-vps-service-test-helper.js';

/**
 * Metal provisioning (spec 2691, ENG-520): an owner's free runtime is placed on
 * the metal host with the most memory headroom under its admission ceiling,
 * recorded in Postgres before hostd creates it, and torn down durably when
 * hostd create fails. Faults detected: wrong placement, a VM created with no
 * platform row, a failed create leaving an orphan VM, and user data that the
 * guest cannot register with.
 */

const GiB = 1024 ** 3;
const MACHINE_ID = '6a0c4f8e-3b1d-4f2a-9c7e-1d2b3c4d5e6f';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const BUNDLE_VERSION = 'matrix-os-host-2026.11.20-1';
const BUNDLE_SHA = 'c'.repeat(64);
/** The golden disk is named after the bundle release it was built from (build-golden-disk.sh). */
const GOLDEN = 'matrix-os-host-2026.11.19-1';
const GOLDEN_SHA = 'd'.repeat(64);

async function registerRelease(db: PlatformDB, version: string, sha256: string) {
  await upsertHostBundleRelease(db, {
    version, gitCommit: '1234567', buildTime: NOW.toISOString(),
    bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, checksumKey: null,
    sha256, size: 100, createdAt: NOW.toISOString(),
  });
}

/**
 * The stable channel points at a newer release than the golden disk, as after
 * a release lands before the hosts' goldens are rebuilt.
 */
async function pinStableBundle(db: PlatformDB) {
  await registerRelease(db, BUNDLE_VERSION, BUNDLE_SHA);
  await promoteHostBundleChannel(db, 'stable', BUNDLE_VERSION, NOW.toISOString());
  await registerRelease(db, GOLDEN, GOLDEN_SHA);
}

/**
 * A PlatformDB whose first VM-record update commits in Postgres but reports an
 * error to the caller, as when the connection drops after commit.
 */
function commitThenFailFirstVmRecord(db: PlatformDB): PlatformDB {
  const recordQueries = new Set<QueryId>();
  let failed = false;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const text = JSON.stringify(node);
      if (node.kind === 'UpdateQueryNode' && text.includes('"metal_vm_id"') && text.includes('"private_address"')) {
        recordQueries.add(queryId);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      if (recordQueries.delete(queryId) && !failed) {
        failed = true;
        throw new Error('connection terminated after commit');
      }
      return result;
    },
  };
  return { ...db, executor: db.executor.withPlugin(plugin), transaction: (fn) => db.transaction(fn) };
}

/**
 * Every VM-record update commits but reports an error (lost replies). After the
 * first commit the guest registers, so the row is running with this VM.
 */
function commitThenFailEveryVmRecordWithRegistration(db: PlatformDB, machineId: string): PlatformDB {
  const recordQueries = new Set<QueryId>();
  let registered = false;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const text = JSON.stringify(node);
      if (node.kind === 'UpdateQueryNode' && text.includes('"metal_vm_id"') && text.includes('"private_address"')) {
        recordQueries.add(queryId);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      if (recordQueries.delete(queryId)) {
        if (!registered) {
          registered = true;
          await db.executor.updateTable('user_machines').set({ status: 'running' }).where('machine_id', '=', machineId).execute();
        }
        throw new Error('connection terminated after commit');
      }
      return result;
    },
  };
  return { ...db, executor: db.executor.withPlugin(plugin), transaction: (fn) => db.transaction(fn) };
}

/** Makes the next `failures` updates that set user_machines.metal_vm_id fail inside Postgres. */
async function failVmRecordUpdates(db: PlatformDB, failures: number) {
  await sql.raw('CREATE SEQUENCE vm_record_failures').execute(db.executor);
  await sql.raw(`
    CREATE FUNCTION fail_vm_record() RETURNS trigger AS $$
    BEGIN
      IF nextval('vm_record_failures') <= ${failures} THEN RAISE EXCEPTION 'injected vm record failure'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `).execute(db.executor);
  await sql.raw(`
    CREATE TRIGGER fail_vm_record BEFORE UPDATE OF metal_vm_id ON user_machines
      FOR EACH ROW EXECUTE FUNCTION fail_vm_record()
  `).execute(db.executor);
}

function hostInput(id: string, overrides: Partial<MetalHostInput> = {}): MetalHostInput {
  return {
    id,
    name: id,
    apiUrl: `https://${id}.metal.example.test:8443`,
    ingressHost: `${id}.metal.example.test`,
    status: 'active',
    memoryCapacityMib: 131072,
    admissionCeilingMib: 114688, // keeps 16384 MiB in reserve
    ...overrides,
  };
}

interface FakeHost {
  client: HostdClient;
  capacity: ReturnType<typeof vi.fn>;
  createVm: ReturnType<typeof vi.fn>;
  listVms: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function fakeHost(capacity: Partial<HostdCapacityResponse> | Error): FakeHost {
  const capacityFn = vi.fn(async () => {
    if (capacity instanceof Error) throw capacity;
    return { memoryAvailableMiB: 0, poolFreeBytes: 1024 * GiB, runningVms: 0, suspendedVms: 0,
      thinPool: { dataPercent: 20, metadataPercent: 5 }, ...capacity };
  });
  const createVm = vi.fn(async (_spec: HostdCreateVmRequest) => ({ id: 'vm_0123456789abcdef01234567', privateIPv4: '10.77.0.9' }));
  const listVms = vi.fn(async () => []);
  const destroy = vi.fn(async () => undefined);
  const unused = async () => { throw new Error('unexpected hostd call'); };
  return {
    capacity: capacityFn,
    createVm,
    listVms,
    destroy,
    client: {
      capacity: capacityFn,
      createVm,
      listVms,
      destroy,
      getVm: unused,
      resume: unused,
      suspend: unused,
      stop: unused,
      setPolicy: unused,
    } as unknown as HostdClient,
  };
}

describe('metal provisioner', () => {
  let db: PlatformDB;
  let template: string;
  let logs: string[];
  const fakes = new Map<string, FakeHost>();

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await pinStableBundle(db);
    template = await loadCustomerVpsCloudInitTemplate();
    fakes.clear();
    logs = [];
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  async function addHost(id: string, capacity: Partial<HostdCapacityResponse> | Error, overrides: Partial<MetalHostInput> = {}) {
    await createMetalHostsRepository(db.kysely).upsert(hostInput(id, overrides));
    const fake = fakeHost(capacity);
    fakes.set(id, fake);
    return fake;
  }

  function provisioner(overrides: { machineIds?: string[]; imageVersion?: string; db?: PlatformDB; publicAppOrigin?: string } = {}) {
    const machineIds = [...(overrides.machineIds ?? [MACHINE_ID])];
    return createMetalProvisioner({
      db: overrides.db ?? db,
      hosts: createMetalHostsRepository(db.kysely),
      clientFor: (host: Pick<MetalHost, 'id'>) => {
        const fake = fakes.get(host.id);
        if (!fake) throw new Error(`no fake for ${host.id}`);
        return fake.client;
      },
      goldenVersion: GOLDEN,
      config: createTestConfig(overrides.imageVersion ? { imageVersion: overrides.imageVersion } : {}),
      cloudInitTemplate: template,
      now: () => NOW,
      sleep: async () => undefined,
      machineIdFactory: () => machineIds.shift() ?? MACHINE_ID,
      tokenFactory: () => ({
        token: 'registration-token',
        hash: hashRegistrationToken('registration-token'),
        expiresAt: '2026-11-21T13:00:00.000Z',
      }),
      postgresPasswordFactory: () => 'postgres-secret',
      ...(overrides.publicAppOrigin !== undefined ? { publicAppOrigin: overrides.publicAppOrigin } : {}),
      log: (event: string) => { logs.push(event); },
    });
  }

  /** A provisioner two hours later, wired like metal-runtime: inline teardown through the real drainer, no worker. */
  function lateProvisioner(host: FakeHost, machineId: string) {
    const at = new Date('2026-11-21T14:00:00.000Z');
    const drainer = createMetalVmDeletionDrainer({
      db, hosts: createMetalHostsRepository(db.kysely), clientFor: () => host.client, now: () => at, log: () => undefined,
    });
    return createMetalProvisioner({
      db,
      hosts: createMetalHostsRepository(db.kysely),
      clientFor: () => host.client,
      goldenVersion: GOLDEN,
      config: createTestConfig(),
      cloudInitTemplate: template,
      now: () => at,
      machineIdFactory: () => machineId,
      drainMachineDeletions: (id, signal) => drainer.drainMachine(id, signal),
      log: () => undefined,
    });
  }

  it('refuses to compose without the real cloud-init template, since the minimal default never finishes first boot', () => {
    const deps = {
      db, hosts: createMetalHostsRepository(db.kysely), clientFor: () => { throw new Error('unused'); },
      goldenVersion: GOLDEN, config: createTestConfig(),
    };
    expect(() => createMetalProvisioner(deps as unknown as Parameters<typeof createMetalProvisioner>[0])).toThrow('cloud-init template');
    expect(() => createMetalProvisioner({ ...deps, cloudInitTemplate: '  ' } as unknown as Parameters<typeof createMetalProvisioner>[0]))
      .toThrow('cloud-init template');
  });

  it('places on the host with the most headroom', async () => {
    const tight = await addHost('host-a', { memoryAvailableMiB: 40_000 });
    const roomy = await addHost('host-b', { memoryAvailableMiB: 60_000 });
    const lowDisk = await addHost('host-c', { memoryAvailableMiB: 90_000, poolFreeBytes: 150 * GiB });
    const unreachable = await addHost('host-d', new HostdError('unreachable'));

    const result = await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });

    expect(result).toEqual({ machineId: MACHINE_ID });
    expect(tight.createVm).not.toHaveBeenCalled();
    expect(lowDisk.createVm).not.toHaveBeenCalled();
    expect(unreachable.createVm).not.toHaveBeenCalled();
    expect(roomy.createVm).toHaveBeenCalledTimes(1);
    const spec = roomy.createVm.mock.calls[0]![0] as HostdCreateVmRequest;
    expect(spec).toMatchObject({
      machineId: MACHINE_ID,
      generation: 1,
      handle: 'alice',
      tier: 'free',
      bootMiB: 2048,
      maxMiB: 8192,
      // The free shape's disk: room for the golden (~17 GB) plus Browser and owner data.
      diskGiB: 40,
      goldenVersion: GOLDEN,
    });
    expect(spec.userData).toContain(`MATRIX_MACHINE_ID=${MACHINE_ID}`);
    expect(spec.userData).toMatch(/^\s*MATRIX_SERVER_PROVIDER=metal$/m);
    expect(spec.userData).toMatch(new RegExp(`^\\s*MATRIX_SERVER_REF=${MACHINE_ID}$`, 'm'));
    // The 40 GiB disk keeps the app and its rollback copy (~4.2 GiB each); the
    // shared 8x-download update check would refuse every update after the first.
    expect(spec.userData).toMatch(/^\s*MATRIX_UPDATE_EXPANSION_FACTOR=5$/m);
    // Production VMs keep the gateway's built-in app origin default.
    expect(spec.userData).not.toContain('MATRIX_PUBLIC_APP_URL=');
    expect(spec.userData).toContain('MATRIX_REGISTRATION_TOKEN=registration-token');
    expect(spec.userData).not.toMatch(/\{\{[A-Za-z0-9_]+\}\}/);
    expect(new TextEncoder().encode(spec.userData).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(logs).toContain('placement_host_unreachable');

    const row = await getUserMachine(db, MACHINE_ID);
    expect(row).toMatchObject({
      substrate: 'metal',
      status: 'provisioning',
      generation: 1,
      metalHostId: 'host-b',
      metalVmId: 'vm_0123456789abcdef01234567',
      privateAddress: '10.77.0.9',
      registrationTokenHash: hashRegistrationToken('registration-token'),
      hetznerServerId: null,
      publicIPv4: null,
    });
  });

  it('preinstalls only Claude Code and Codex on a free VM, and the default set on a paid one', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });

    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    const free = host.createVm.mock.calls[0]![0] as HostdCreateVmRequest;
    expect(free.userData).toMatch(/^\s*MATRIX_DEVELOPER_TOOLS='codex claude-code'$/m);
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({ developerTools: ['codex', 'claude-code'] });

    await provisioner({ machineIds: ['0f1e2d3c-4b5a-4968-8776-655443322110'] })
      .provision({ clerkUserId: 'user_other', handle: 'bob', tier: 'paid' });
    const paid = host.createVm.mock.calls[1]![0] as HostdCreateVmRequest;
    expect(paid.userData).toMatch(/^\s*MATRIX_DEVELOPER_TOOLS='codex claude-code opencode pi'$/m);
  });

  it('honours a paid owner\'s plan-step tool choice, canonicalized, but never a free owner\'s', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });

    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'paid', developerTools: ['pi', 'codex', 'pi'] });
    expect((host.createVm.mock.calls[0]![0] as HostdCreateVmRequest).userData).toMatch(/^\s*MATRIX_DEVELOPER_TOOLS='codex pi'$/m);
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({ developerTools: ['codex', 'pi'] });

    await provisioner({ machineIds: ['0f1e2d3c-4b5a-4968-8776-655443322110'] })
      .provision({ clerkUserId: 'user_other', handle: 'bob', tier: 'free', developerTools: ['opencode', 'pi'] });
    expect((host.createVm.mock.calls[1]![0] as HostdCreateVmRequest).userData).toMatch(/^\s*MATRIX_DEVELOPER_TOOLS='codex claude-code'$/m);

    // An unknown tool is refused, not silently dropped.
    expect(await provisioner({ machineIds: ['1f1e2d3c-4b5a-4968-8776-655443322110'] })
      .provision({ clerkUserId: 'user_third', handle: 'carol', tier: 'paid', developerTools: ['vim' as never] }))
      .toEqual({ error: 'unavailable' });
  });

  it('skips hosts whose thin pool is unknown or past the thresholds, and prefers the emptier pool', async () => {
    const unknown = await addHost('host-a', { memoryAvailableMiB: 90_000, thinPool: null });
    const fullData = await addHost('host-b', { memoryAvailableMiB: 90_000, thinPool: { dataPercent: 86, metadataPercent: 5 } });
    const fullMeta = await addHost('host-c', { memoryAvailableMiB: 90_000, thinPool: { dataPercent: 10, metadataPercent: 81 } });
    const busier = await addHost('host-d', { memoryAvailableMiB: 60_000, thinPool: { dataPercent: 70, metadataPercent: 5 } });
    const emptier = await addHost('host-e', { memoryAvailableMiB: 60_000, thinPool: { dataPercent: 30, metadataPercent: 5 } });

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ machineId: MACHINE_ID });
    for (const skipped of [unknown, fullData, fullMeta, busier]) expect(skipped.createVm).not.toHaveBeenCalled();
    expect(emptier.createVm).toHaveBeenCalledTimes(1);
  });

  it('places on another host when hostd refuses for capacity, without failing the build', async () => {
    const first = await addHost('host-a', { memoryAvailableMiB: 90_000 });
    const second = await addHost('host-b', { memoryAvailableMiB: 60_000 });
    first.createVm.mockRejectedValueOnce(new HostdError('capacity'));

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ machineId: MACHINE_ID });
    expect(second.createVm).toHaveBeenCalledTimes(1);
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({ status: 'provisioning', metalHostId: 'host-b', attempt: 1 });
    expect(await db.executor.selectFrom('metal_vm_deletions').selectAll().execute()).toEqual([]);
  });

  it('answers busy when every host refuses for capacity, and the next build is still attempt 1', async () => {
    const only = await addHost('host-a', { memoryAvailableMiB: 90_000 });
    only.createVm.mockRejectedValueOnce(new HostdError('capacity'));

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ error: 'busy' });
    expect(await getActiveUserMachineByClerkId(db, 'user_metal', 'primary')).toBeUndefined();
    expect(await db.executor.selectFrom('user_machines').select('status')
      .where('machine_id', '=', MACHINE_ID).executeTakeFirst()).toEqual({ status: 'deleted' });
    expect(await db.executor.selectFrom('metal_vm_deletions').selectAll().execute()).toMatchObject([
      { machine_id: MACHINE_ID, generation: 1, reason: 'capacity_refused', completed_at: NOW },
    ]);

    expect(await provisioner({ machineIds: ['0f1e2d3c-4b5a-4968-8776-655443322110'] })
      .provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ machineId: '0f1e2d3c-4b5a-4968-8776-655443322110' });
    expect(await getUserMachine(db, '0f1e2d3c-4b5a-4968-8776-655443322110')).toMatchObject({ attempt: 1 });
  });

  it('a rebuild that no host has room for keeps the attempt history: busy now, attempt 3 next', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 90_000 });
    await insertUserMachine(db, {
      machineId: 'b7a6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d', clerkUserId: 'user_metal', handle: 'alice', status: 'failed',
      substrate: 'metal', metalHostId: 'host-a', hetznerServerId: null, publicIPv4: null, attempt: 2,
      imageVersion: GOLDEN, provisionedAt: NOW.toISOString(),
    });
    host.createVm.mockRejectedValueOnce(new HostdError('capacity'));
    const shared = provisioner({ machineIds: [MACHINE_ID, '0f1e2d3c-4b5a-4968-8776-655443322110'] });

    expect(await shared.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ error: 'busy' });
    // The owner still has a failed build at attempt 2 (the journey keeps offering its retry).
    expect(await getActiveUserMachineByClerkId(db, 'user_metal', 'primary')).toMatchObject({ status: 'failed', attempt: 2 });

    // Busy consumed neither an attempt nor the rebuild throttle: an immediate retry builds attempt 3.
    expect(await shared.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ machineId: '0f1e2d3c-4b5a-4968-8776-655443322110' });
    expect(await getUserMachine(db, '0f1e2d3c-4b5a-4968-8776-655443322110')).toMatchObject({ attempt: 3, status: 'provisioning' });
  });

  it('a rebuild refused by placement (no host fits) does not consume the rebuild throttle', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 1_000 });
    await insertUserMachine(db, {
      machineId: 'b7a6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d', clerkUserId: 'user_metal', handle: 'alice', status: 'failed',
      substrate: 'metal', metalHostId: 'host-a', hetznerServerId: null, publicIPv4: null, attempt: 1,
      imageVersion: GOLDEN, provisionedAt: NOW.toISOString(),
    });
    const shared = provisioner();
    expect(await shared.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ error: 'busy' });
    host.capacity.mockImplementation(async () => ({ memoryAvailableMiB: 90_000, poolFreeBytes: 1024 * GiB, runningVms: 0,
      suspendedVms: 0, thinPool: { dataPercent: 20, metadataPercent: 5 } }));
    expect(await shared.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ machineId: MACHINE_ID });
  });

  it('places on a legacy hostd that reports no thin pool, with a warning, but never on an unreadable one', async () => {
    const legacy = await addHost('host-a', { memoryAvailableMiB: 90_000, thinPool: undefined });
    await addHost('host-b', { memoryAvailableMiB: 95_000, thinPool: null });

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ machineId: MACHINE_ID });
    expect(legacy.createVm).toHaveBeenCalledTimes(1);
    expect(logs).toContain('placement_thin_pool_unreported');
  });

  it('breaks a headroom tie by the fewest running VMs', async () => {
    const busy = await addHost('host-a', { memoryAvailableMiB: 50_000, runningVms: 30 });
    const quiet = await addHost('host-b', { memoryAvailableMiB: 50_000, runningVms: 3 });

    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });

    expect(busy.createVm).not.toHaveBeenCalled();
    expect(quiet.createVm).toHaveBeenCalledTimes(1);
  });

  it('returns busy when no host is under its ceiling', async () => {
    // 16384 MiB reserve + 2048 MiB boot: 18000 MiB available leaves too little headroom.
    const a = await addHost('host-a', { memoryAvailableMiB: 18_000 });
    const b = await addHost('host-b', { memoryAvailableMiB: 16_384 });

    const result = await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });

    expect(result).toEqual({ error: 'busy' });
    expect(a.createVm).not.toHaveBeenCalled();
    expect(b.createVm).not.toHaveBeenCalled();
    expect(await getUserMachine(db, MACHINE_ID)).toBeUndefined();
  });

  it('returns unavailable when every host is unreachable or none is active', async () => {
    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'unavailable' });

    await addHost('host-a', new HostdError('timeout'));
    await addHost('host-b', { memoryAvailableMiB: 90_000 }, { status: 'draining' });

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'unavailable' });
    expect(fakes.get('host-b')!.capacity).not.toHaveBeenCalled();
    expect(await getUserMachine(db, MACHINE_ID)).toBeUndefined();
  });

  it('a hostd create failure marks the row failed and queues destroy', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    host.createVm.mockRejectedValueOnce(new HostdError('internal'));

    const result = await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });

    expect(result).toEqual({ error: 'unavailable' });
    const row = await getUserMachine(db, MACHINE_ID);
    expect(row).toMatchObject({ status: 'failed', failureCode: 'provider_unavailable', metalVmId: null });
    const queued = await db.executor.selectFrom('metal_vm_deletions').selectAll().execute();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      metal_host_id: 'host-a',
      machine_id: MACHINE_ID,
      generation: 1,
      metal_vm_id: null,
      completed_at: null,
    });
  });

  it('maps a full host at create time to busy and still queues destroy', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    host.createVm.mockRejectedValueOnce(new HostdError('pool_full'));

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'busy' });
    expect((await getUserMachine(db, MACHINE_ID))?.status).toBe('failed');
    expect(await db.executor.selectFrom('metal_vm_deletions').select('machine_id').execute())
      .toEqual([{ machine_id: MACHINE_ID }]);
  });

  it('concurrent provisions for the same owner share one row and one create', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    const second = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
    const p = provisioner({ machineIds: [MACHINE_ID, second] });

    const results = await Promise.all([
      p.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }),
      p.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }),
    ]);

    const ids = results.map((result) => ('machineId' in result ? result.machineId : result.error));
    expect(new Set(ids).size).toBe(1);
    expect(host.createVm).toHaveBeenCalledTimes(1);
    const rows = await db.executor.selectFrom('user_machines').select('machine_id')
      .where('clerk_user_id', '=', 'user_metal').where('deleted_at', 'is', null).execute();
    expect(rows).toHaveLength(1);
  });

  it('a retry after a failed create retires the failed row and provisions a fresh one', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    host.createVm.mockRejectedValueOnce(new HostdError('internal'));
    const retry = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
    const p = provisioner({ machineIds: [MACHINE_ID, retry] });

    await p.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    const result = await p.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });

    expect(result).toEqual({ machineId: retry });
    expect((await getUserMachine(db, MACHINE_ID))?.deletedAt).not.toBeNull();
    expect((await getUserMachine(db, retry))?.status).toBe('provisioning');
  });

  it('refuses a slot held by a non-metal runtime without touching it', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await insertUserMachine(db, {
      machineId: 'b7a6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d',
      clerkUserId: 'user_metal',
      handle: 'alice',
      runtimeSlot: 'primary',
      status: 'running',
      imageVersion: 'v1',
      provisionedAt: NOW.toISOString(),
    });

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'unavailable' });
    expect(host.createVm).not.toHaveBeenCalled();
  });

  it('pins the golden disk\'s bundle, not the update channel\'s, on the metal row so registration verifies it', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });

    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });

    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({
      imageVersion: GOLDEN,
      targetBundleVersion: GOLDEN,
      targetBundleSha256: GOLDEN_SHA,
    });
    const spec = host.createVm.mock.calls[0]![0] as HostdCreateVmRequest;
    expect(spec.userData).toMatch(new RegExp(`^\\s*MATRIX_TARGET_BUNDLE_SHA256=${GOLDEN_SHA}$`, 'm'));
    expect(spec.userData).toMatch(new RegExp(`^\\s*MATRIX_IMAGE_VERSION=${GOLDEN}$`, 'm'));
  });

  it('provisions on a channel with no pinned release, since the golden pins the bundle', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });

    expect(await provisioner({ imageVersion: 'beta' }).provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ machineId: MACHINE_ID });
    expect(host.createVm).toHaveBeenCalledTimes(1);
  });

  it('refuses to provision when the golden disk\'s bundle is not a registered release', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await db.executor.deleteFrom('host_bundle_releases').where('version', '=', GOLDEN).execute();

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'unavailable' });
    expect(host.createVm).not.toHaveBeenCalled();
    expect(await getUserMachine(db, MACHINE_ID)).toBeUndefined();
    expect(logs).toContain('golden_bundle_unpinned');
  });

  it('retries recording the created VM and keeps the runtime when a retry succeeds', async () => {
    await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await failVmRecordUpdates(db, 2);

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ machineId: MACHINE_ID });
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({
      status: 'provisioning',
      metalVmId: 'vm_0123456789abcdef01234567',
      privateAddress: '10.77.0.9',
    });
    expect(await db.executor.selectFrom('metal_vm_deletions').select('id').execute()).toEqual([]);
  });

  it('a retry after an ambiguous commit recognises its own VM record and keeps the runtime', async () => {
    await addHost('host-a', { memoryAvailableMiB: 60_000 });

    expect(await provisioner({ db: commitThenFailFirstVmRecord(db) })
      .provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ machineId: MACHINE_ID });
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({
      status: 'provisioning',
      metalVmId: 'vm_0123456789abcdef01234567',
      privateAddress: '10.77.0.9',
    });
    expect(await db.executor.selectFrom('metal_vm_deletions').select('id').execute()).toEqual([]);
  });

  it('keeps a VM the guest registered while every record reply was lost, instead of queueing its teardown', async () => {
    await addHost('host-a', { memoryAvailableMiB: 60_000 });

    expect(await provisioner({ db: commitThenFailEveryVmRecordWithRegistration(db, MACHINE_ID) })
      .provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ machineId: MACHINE_ID });
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({ status: 'running', metalVmId: 'vm_0123456789abcdef01234567' });
    expect(await db.executor.selectFrom('metal_vm_deletions').select('id').execute()).toEqual([]);
  });

  it('still treats a row holding a different VM id as superseded', async () => {
    await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await sql.raw(`
      CREATE FUNCTION claim_other_vm() RETURNS trigger AS $$
      BEGIN NEW.metal_vm_id := 'vm_ffffffffffffffffffffffff'; RETURN NEW; END $$ LANGUAGE plpgsql
    `).execute(db.executor);
    await sql.raw(`
      CREATE TRIGGER claim_other_vm BEFORE INSERT ON user_machines FOR EACH ROW EXECUTE FUNCTION claim_other_vm()
    `).execute(db.executor);

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'unavailable' });
    expect(await db.executor.selectFrom('metal_vm_deletions').select(['machine_id', 'metal_vm_id']).execute())
      .toEqual([{ machine_id: MACHINE_ID, metal_vm_id: 'vm_0123456789abcdef01234567' }]);
  });

  it('gives up recording the created VM after bounded retries, fails the row and queues teardown with the VM id', async () => {
    await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await failVmRecordUpdates(db, 3);

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'unavailable' });
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({ status: 'failed', metalVmId: null });
    expect(await db.executor.selectFrom('metal_vm_deletions').select(['machine_id', 'metal_vm_id']).execute())
      .toEqual([{ machine_id: MACHINE_ID, metal_vm_id: 'vm_0123456789abcdef01234567' }]);
  });

  it('a retry after the registration window closed fails the stuck row and provisions afresh, even with no maintenance worker', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    const second = '0f1e2d3c-4b5a-4968-8776-655443322110';
    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    const later = lateProvisioner(host, second);

    expect(await later.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ machineId: second });
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({ status: 'failed', failureCode: 'registration_timeout' });
    expect(host.createVm).toHaveBeenCalledTimes(2);
    // No maintenance worker drains the queue here, so the stuck VM is destroyed inline.
    expect(host.destroy).toHaveBeenCalledWith('vm_0123456789abcdef01234567', expect.any(AbortSignal));
    const deletions = await db.executor.selectFrom('metal_vm_deletions')
      .select(['machine_id', 'metal_vm_id', 'completed_at']).execute();
    expect(deletions).toEqual([{ machine_id: MACHINE_ID, metal_vm_id: 'vm_0123456789abcdef01234567', completed_at: expect.anything() }]);
  });

  it('a failed inline destroy of the stuck VM leaves its queued teardown for the drainer', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    const second = '0f1e2d3c-4b5a-4968-8776-655443322110';
    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    host.destroy.mockRejectedValueOnce(new HostdError('unreachable'));

    expect(await lateProvisioner(host, second).provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ machineId: second });
    expect(await db.executor.selectFrom('metal_vm_deletions')
      .select(['machine_id', 'metal_vm_id', 'completed_at', 'last_error']).execute())
      .toEqual([{ machine_id: MACHINE_ID, metal_vm_id: 'vm_0123456789abcdef01234567', completed_at: null, last_error: 'unreachable' }]);
  });

  it('a retry inside the registration window returns the provisioning runtime', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });

    expect(await provisioner({ machineIds: ['0f1e2d3c-4b5a-4968-8776-655443322110'] })
      .provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ machineId: MACHINE_ID });
    expect(host.createVm).toHaveBeenCalledTimes(1);
  });

  it('refuses to rebuild past the attempt ceiling without touching hostd', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await insertUserMachine(db, {
      machineId: 'b7a6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d', clerkUserId: 'user_metal', handle: 'alice', status: 'failed',
      substrate: 'metal', metalHostId: 'host-a', hetznerServerId: null, publicIPv4: null, attempt: 3,
      imageVersion: GOLDEN, provisionedAt: NOW.toISOString(),
    });

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'retry_exhausted' });
    expect(host.capacity).not.toHaveBeenCalled();
    expect(host.createVm).not.toHaveBeenCalled();
  });

  it('never retires a failed metal runtime that had registered', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await insertUserMachine(db, {
      machineId: 'b7a6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d', clerkUserId: 'user_metal', handle: 'alice', status: 'failed',
      substrate: 'metal', metalHostId: 'host-a', hetznerServerId: null, publicIPv4: null,
      lastSeenAt: '2026-11-20T00:00:00.000Z', imageVersion: GOLDEN, provisionedAt: NOW.toISOString(),
    });

    expect(await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'support_required' });
    expect(host.createVm).not.toHaveBeenCalled();
    expect(await getUserMachine(db, 'b7a6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d')).toMatchObject({ status: 'failed', deletedAt: null });
  });

  it('throttles rebuild starts per owner', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    host.createVm.mockRejectedValue(new HostdError('internal'));
    const shared = provisioner({ machineIds: [MACHINE_ID, '0f1e2d3c-4b5a-4968-8776-655443322110', '1f1e2d3c-4b5a-4968-8776-655443322110'] });

    expect(await shared.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ error: 'unavailable' });
    // The first rebuild after the failure is admitted; a second inside the window is not.
    expect(await shared.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ error: 'unavailable' });
    expect(await shared.provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' })).toEqual({ error: 'throttled' });
    expect(host.createVm).toHaveBeenCalledTimes(2);
  });

  it('drain() waits for a read path\'s background teardown, so shutdown does not cut it off', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    let release!: () => void;
    const later = createMetalProvisioner({
      db, hosts: createMetalHostsRepository(db.kysely), clientFor: () => host.client, goldenVersion: GOLDEN,
      config: createTestConfig(), cloudInitTemplate: template, now: () => new Date('2026-11-21T14:00:00.000Z'),
      drainMachineDeletions: () => new Promise<void>((resolve) => { release = resolve; }), log: () => undefined,
    });

    expect(await later.failExpiredProvisioning('user_metal', 'primary')).toBe('failed');
    let drained = false;
    const draining = later.drain().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
  });

  it('fails a metal row whose registration window expired and queues its destroy', async () => {
    await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    const later = createMetalProvisioner({
      db,
      hosts: createMetalHostsRepository(db.kysely),
      clientFor: () => fakes.get('host-a')!.client,
      goldenVersion: GOLDEN,
      config: createTestConfig(),
      cloudInitTemplate: template,
      now: () => new Date('2026-11-21T14:00:00.000Z'),
    });

    expect(await later.reconcileStale()).toEqual({ failed: 1 });
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({ status: 'failed', failureCode: 'registration_timeout' });
    expect(await db.executor.selectFrom('metal_vm_deletions').select(['machine_id', 'metal_vm_id']).execute())
      .toEqual([{ machine_id: MACHINE_ID, metal_vm_id: 'vm_0123456789abcdef01234567' }]);
  });
  it('gives a VM its platform app origin so Browser and Cloud desktop accept requests from it', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await provisioner({ publicAppOrigin: 'https://metal-preview.matrix-os.com' })
      .provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    const spec = host.createVm.mock.calls[0]![0] as HostdCreateVmRequest;
    expect(spec.userData).toMatch(/^\s*MATRIX_PUBLIC_APP_URL=https:\/\/metal-preview\.matrix-os\.com$/m);
  });

  it('leaves out an app origin that is not a bare https origin', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await provisioner({ publicAppOrigin: 'http://evil.example\nMATRIX_X=1' })
      .provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    const spec = host.createVm.mock.calls[0]![0] as HostdCreateVmRequest;
    expect(spec.userData).not.toContain('MATRIX_PUBLIC_APP_URL=');
    expect(spec.userData).not.toContain('MATRIX_X=1');
  });
});

describe('metal VM deletion drainer', () => {
  let db: PlatformDB;
  const fakes = new Map<string, FakeHost>();

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await pinStableBundle(db);
    fakes.clear();
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  async function queueFailedCreate(createError: HostdError) {
    await createMetalHostsRepository(db.kysely).upsert(hostInput('host-a'));
    const fake = fakeHost({ memoryAvailableMiB: 60_000 });
    fake.createVm.mockRejectedValueOnce(createError);
    fakes.set('host-a', fake);
    await createMetalProvisioner({
      db,
      hosts: createMetalHostsRepository(db.kysely),
      clientFor: () => fake.client,
      goldenVersion: GOLDEN,
      config: createTestConfig(),
      cloudInitTemplate: await loadCustomerVpsCloudInitTemplate(),
      now: () => NOW,
      machineIdFactory: () => MACHINE_ID,
      log: () => undefined,
    }).provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    return fake;
  }

  function drainer(now = NOW) {
    return createMetalVmDeletionDrainer({
      db,
      hosts: createMetalHostsRepository(db.kysely),
      clientFor: (host: Pick<MetalHost, 'id'>) => fakes.get(host.id)!.client,
      now: () => now,
      log: () => undefined,
    });
  }

  it('destroys the VM hostd holds for the machine generation and completes the entry', async () => {
    const fake = await queueFailedCreate(new HostdError('internal'));
    fake.listVms.mockResolvedValueOnce([
      { id: 'vm_aaaaaaaaaaaaaaaaaaaaaaaa', machineId: 'someone-else', generation: 1 },
      { id: 'vm_bbbbbbbbbbbbbbbbbbbbbbbb', machineId: MACHINE_ID, generation: 1 },
    ]);

    expect(await drainer().drainOnce()).toEqual({ completed: 1, retried: 0 });

    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(fake.destroy).toHaveBeenCalledWith('vm_bbbbbbbbbbbbbbbbbbbbbbbb');
    const rows = await db.executor.selectFrom('metal_vm_deletions').select(['completed_at', 'attempts']).execute();
    expect(rows[0]?.completed_at).not.toBeNull();
    expect(await drainer().drainOnce()).toEqual({ completed: 0, retried: 0 });
  });

  it('after a create timeout, waits out the create window and destroys the VM once hostd lists it', async () => {
    const fake = await queueFailedCreate(new HostdError('timeout'));
    const at = (ms: number) => new Date(NOW.getTime() + ms);

    // hostd may still be cloning: nothing is attempted inside twice the create timeout.
    expect(await drainer(at(60_000)).drainOnce()).toEqual({ completed: 0, retried: 0 });
    expect(fake.listVms).not.toHaveBeenCalled();

    // Past the window but hostd does not list the VM yet: the id-less entry stays open.
    expect(await drainer(at(5 * 60_000)).drainOnce()).toEqual({ completed: 0, retried: 1 });
    expect(fake.destroy).not.toHaveBeenCalled();
    expect((await db.executor.selectFrom('metal_vm_deletions').select('completed_at').executeTakeFirst())?.completed_at)
      .toBeNull();

    fake.listVms.mockResolvedValueOnce([{ id: 'vm_cccccccccccccccccccccccc', machineId: MACHINE_ID, generation: 1 }]);
    expect(await drainer(at(7 * 60_000)).drainOnce()).toEqual({ completed: 1, retried: 0 });
    expect(fake.destroy).toHaveBeenCalledWith('vm_cccccccccccccccccccccccc');
  });

  it('completes an id-less entry on an empty listing only after the grace period', async () => {
    await queueFailedCreate(new HostdError('internal'));

    expect(await drainer().drainOnce()).toEqual({ completed: 0, retried: 1 });
    expect(await drainer(new Date(NOW.getTime() + 11 * 60_000)).drainOnce()).toEqual({ completed: 1, retried: 0 });
  });

  it('keeps the entry and backs off when hostd is unreachable', async () => {
    const fake = await queueFailedCreate(new HostdError('internal'));
    fake.listVms.mockRejectedValueOnce(new HostdError('unreachable'));

    expect(await drainer().drainOnce()).toEqual({ completed: 0, retried: 1 });
    const [row] = await db.executor.selectFrom('metal_vm_deletions').selectAll().execute();
    expect(row).toMatchObject({ completed_at: null, attempts: 1, last_error: 'unreachable' });
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(NOW.getTime());
    // Not due yet: the next pass leaves it alone.
    expect(await drainer().drainOnce()).toEqual({ completed: 0, retried: 0 });
  });

});
