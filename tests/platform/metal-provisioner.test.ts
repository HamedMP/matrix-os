import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostdCapacityResponse, HostdCreateVmRequest } from '@matrix-os/contracts';
import { sql, type KyselyPlugin, type QueryId } from 'kysely';
import {
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
const GOLDEN = 'golden-2026.11.20-1';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const BUNDLE_VERSION = 'matrix-os-host-2026.11.20-1';
const BUNDLE_SHA = 'c'.repeat(64);

/** The stable channel points at a release with a known digest, as in production. */
async function pinStableBundle(db: PlatformDB) {
  await upsertHostBundleRelease(db, {
    version: BUNDLE_VERSION, gitCommit: '1234567', buildTime: NOW.toISOString(),
    bundleKey: `system-bundles/${BUNDLE_VERSION}/matrix-host-bundle.tar.gz`, checksumKey: null,
    sha256: BUNDLE_SHA, size: 100, createdAt: NOW.toISOString(),
  });
  await promoteHostBundleChannel(db, 'stable', BUNDLE_VERSION, NOW.toISOString());
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
    return { memoryAvailableMiB: 0, poolFreeBytes: 1024 * GiB, runningVms: 0, suspendedVms: 0, ...capacity };
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

  function provisioner(overrides: { machineIds?: string[]; imageVersion?: string; db?: PlatformDB } = {}) {
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
      log: (event: string) => { logs.push(event); },
    });
  }

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
      diskGiB: 20,
      goldenVersion: GOLDEN,
    });
    expect(spec.userData).toContain(`MATRIX_MACHINE_ID=${MACHINE_ID}`);
    expect(spec.userData).toMatch(/^\s*MATRIX_SERVER_PROVIDER=metal$/m);
    expect(spec.userData).toMatch(new RegExp(`^\\s*MATRIX_SERVER_REF=${MACHINE_ID}$`, 'm'));
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

  it('pins the host bundle on the metal row so registration verifies it', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });

    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });

    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({
      imageVersion: BUNDLE_VERSION,
      targetBundleVersion: BUNDLE_VERSION,
      targetBundleSha256: BUNDLE_SHA,
    });
    const spec = host.createVm.mock.calls[0]![0] as HostdCreateVmRequest;
    expect(spec.userData).toMatch(new RegExp(`^\\s*MATRIX_TARGET_BUNDLE_SHA256=${BUNDLE_SHA}$`, 'm'));
  });

  it('refuses to provision when the bundle channel has no pinned release', async () => {
    const host = await addHost('host-a', { memoryAvailableMiB: 60_000 });

    expect(await provisioner({ imageVersion: 'beta' }).provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' }))
      .toEqual({ error: 'unavailable' });
    expect(host.createVm).not.toHaveBeenCalled();
    expect(await getUserMachine(db, MACHINE_ID)).toBeUndefined();
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

  it('fails a metal row whose registration window expired and queues its destroy', async () => {
    await addHost('host-a', { memoryAvailableMiB: 60_000 });
    await provisioner().provision({ clerkUserId: 'user_metal', handle: 'alice', tier: 'free' });
    const later = createMetalProvisioner({
      db,
      hosts: createMetalHostsRepository(db.kysely),
      clientFor: () => fakes.get('host-a')!.client,
      goldenVersion: GOLDEN,
      config: createTestConfig(),
      now: () => new Date('2026-11-21T14:00:00.000Z'),
    });

    expect(await later.reconcileStale()).toEqual({ failed: 1 });
    expect(await getUserMachine(db, MACHINE_ID)).toMatchObject({ status: 'failed', failureCode: 'registration_timeout' });
    expect(await db.executor.selectFrom('metal_vm_deletions').select(['machine_id', 'metal_vm_id']).execute())
      .toEqual([{ machine_id: MACHINE_ID, metal_vm_id: 'vm_0123456789abcdef01234567' }]);
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
