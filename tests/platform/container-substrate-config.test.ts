import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  createConfiguredContainerSubstrate,
  loadContainerSubstrateConfig,
} from '../../packages/platform/src/substrates/container-substrate-config.js';
import type { LambdaMicrovmsApi } from '../../packages/platform/src/substrates/container-provider.js';
import type { OwnerClusterAdmin } from '../../packages/platform/src/substrates/container-owner-database.js';
import { createPlatformSubstrateRegistry } from '../../packages/platform/src/substrates/platform-substrates.js';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const SECRET = 'p'.repeat(40);
const ENV = {
  MATRIX_CONTAINER_SUBSTRATE_ENABLED: 'true',
  MATRIX_CONTAINER_IMAGE: 'arn:aws:lambda:eu-west-1:000000000000:microvm-image:matrix-runtime',
  MATRIX_CONTAINER_INGRESS_CONNECTORS: 'arn:aws:lambda:eu-west-1:aws:network-connector:aws-network-connector:HTTP_INGRESS',
  MATRIX_CONTAINER_EGRESS_CONNECTORS: 'arn:aws:lambda:eu-west-1:000000000000:network-connector:egress',
  MATRIX_CONTAINER_OWNER_DB_ADMIN_URL: 'postgres://admin:admin-secret@127.0.0.1:5432/postgres',
  MATRIX_CONTAINER_OWNER_DB_RUNTIME_HOST: 'owners.internal.example',
  MATRIX_CONTAINER_OWNER_DB_PASSWORD_SECRET: SECRET,
};

function fakeApi(): LambdaMicrovmsApi {
  return {
    runMicrovm: vi.fn(async () => ({
      microvmId: 'mvm-a', state: 'PENDING', endpoint: 'mvm-a.lambda-microvm.eu-west-1.on.aws',
      maximumDurationInSeconds: 28_800, startedAt: new Date(),
    })),
    getMicrovm: vi.fn(async () => ({})),
    suspendMicrovm: vi.fn(async () => ({})),
    resumeMicrovm: vi.fn(async () => ({})),
    terminateMicrovm: vi.fn(async () => ({})),
    listMicrovms: vi.fn(async () => ({ items: [] })),
    createMicrovmAuthToken: vi.fn(async () => ({ authToken: { 'X-aws-proxy-auth': 't' } })),
  };
}

describe('container substrate configuration', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(loadContainerSubstrateConfig({})).toEqual({ ok: false, reason: 'disabled' });
  });

  it('names missing settings without echoing any values', () => {
    const result = loadContainerSubstrateConfig({ ...ENV, MATRIX_CONTAINER_IMAGE: '', MATRIX_CONTAINER_OWNER_DB_PASSWORD_SECRET: 'short' });
    expect(result).toEqual({
      ok: false, reason: 'incomplete',
      invalid: ['MATRIX_CONTAINER_IMAGE', 'MATRIX_CONTAINER_OWNER_DB_PASSWORD_SECRET'],
    });
    expect(JSON.stringify(result)).not.toContain('admin-secret');
  });

  it('applies defaults and parses lists', () => {
    const result = loadContainerSubstrateConfig(ENV);
    expect(result.ok && result.config).toMatchObject({
      provider: {
        gatewayPort: 4000, endpointTokenMinutes: 30, endpointHostSuffix: '.on.aws',
        egressNetworkConnectors: [ENV.MATRIX_CONTAINER_EGRESS_CONNECTORS],
      },
      ownerDatabase: { runtimeHost: 'owners.internal.example', runtimePort: 5432, sizeLimitBytes: 1024 ** 3 },
    });
  });
});

describe('container substrate registration', () => {
  let db: PlatformDB;
  const logs: string[] = [];
  const log = (message: string) => { logs.push(message); };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    logs.length = 0;
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('is not registered when configuration is incomplete', () => {
    const configured = createConfiguredContainerSubstrate({ db, env: { MATRIX_CONTAINER_SUBSTRATE_ENABLED: 'true' }, microvmsApi: fakeApi(), log });
    expect(configured).toBeNull();
    expect(createPlatformSubstrateRegistry(db).get('container')).toEqual({ ok: false, reason: 'substrate_unavailable' });
    expect(logs.join('\n')).toContain('MATRIX_CONTAINER_IMAGE');
  });

  it('is not registered without a provider client, even with complete settings', () => {
    expect(createConfiguredContainerSubstrate({ db, env: ENV, log })).toBeNull();
    expect(logs.join('\n')).toContain('provider client');
  });

  it('registers alongside the vps substrate when complete', async () => {
    const cluster = await createTestPGlite();
    const admin: OwnerClusterAdmin = {
      async query(statement, params) { return (await cluster.client.query(statement, [...params])).rows as Record<string, unknown>[]; },
      async executeInDatabase() { return undefined; },
    };
    const api = fakeApi();
    const configured = createConfiguredContainerSubstrate({ db, env: ENV, microvmsApi: api, ownerClusterAdmin: admin, log })!;
    try {
      const registry = createPlatformSubstrateRegistry(db, [configured.substrate]);
      expect(registry.get('container')).toEqual({ ok: true, substrate: configured.substrate });
      expect(registry.get('vps').ok).toBe(true);

      await insertUserMachine(db, {
        machineId: 'ctr-1', clerkUserId: 'user_a', handle: 'alice', status: 'stopped',
        provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container',
      });
      const ref = { machineId: 'ctr-1', handle: 'alice', runtimeSlot: 'primary', generation: 1 };
      expect(await configured.substrate.ensureRunning(ref, AbortSignal.timeout(10_000))).toEqual({ state: 'starting' });
      await configured.lifecycle.drain();

      const payload = JSON.parse(vi.mocked(api.runMicrovm).mock.calls[0]![0].runHookPayload!);
      const owner = await db.executor.selectFrom('container_owner_databases').selectAll().executeTakeFirstOrThrow();
      expect(payload).toEqual({
        version: 1,
        machineId: 'ctr-1',
        handle: 'alice',
        runtimeSlot: 'primary',
        generation: 2,
        runtimeTokenEpoch: 2,
        database: {
          host: 'owners.internal.example', port: 5432, name: owner.database_name, user: owner.role_name,
          password: configured.ownerDatabases.passwordFor(owner.role_name, 2),
        },
      });
      expect(owner.password_epoch).toBe(2);
    } finally {
      await configured.shutdown();
      await cluster.client.close();
    }
  });
});
