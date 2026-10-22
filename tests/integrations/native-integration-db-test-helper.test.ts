import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeIntegrationFixtureManager } from './native-integration-db-test-helper.js';
import * as gatewayDb from '../../packages/gateway/src/platform-db.js';
import * as engines from '../helpers/pglite-test-helper.js';

const liveUrl = process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL;
const managers: ReturnType<typeof createNativeIntegrationFixtureManager>[] = [];
beforeEach(() => { vi.stubEnv('MATRIX_PLATFORM_FIXTURE_POSTGRES_URL', undefined); });
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function manager() {
  const value = createNativeIntegrationFixtureManager();
  managers.push(value);
  return value;
}
async function verifyIsolation(url?: string) {
  const fixtures = manager();
  const [{ db: first }, { db: second }] = await Promise.all([
    fixtures.createTestPlatformDb(url), fixtures.createTestPlatformDb(url),
  ]);
  const input = { clerkId: 'same-clerk', handle: 'same-handle', displayName: 'Fixture User',
    email: 'fixture@example.com', containerId: 'fixture-container' };
  for (const db of [first, second]) {
    expect((await db.raw('SELECT count(*)::int AS count FROM users', [])).rows).toEqual([{ count: 0 }]);
    const user = await db.createUser(input);
    expect(user).toMatchObject({ plan: 'free', status: 'active', handle: 'same-handle' });
    await expect(db.createUser(input)).rejects.toThrow();
    await db.raw('CREATE SEQUENCE fixture_sequence', []);
    expect((await db.raw('SELECT nextval(\'fixture_sequence\') AS value', [])).rows).toEqual([{ value: 1 }]);
  }
  await first.raw('CREATE TABLE fixture_only (id int)', []);
  expect((await second.raw("SELECT to_regclass('public.fixture_only') AS relation", [])).rows)
    .toEqual([{ relation: null }]);
  await fixtures.destroyTestPlatformDb(first);
  expect(await second.getUserByClerkId(input.clerkId)).not.toBeNull();
  await fixtures.destroyTestPlatformDb(second);
  const { db: replacement } = await fixtures.createTestPlatformDb(url);
  expect((await replacement.raw('SELECT count(*)::int AS count FROM users', [])).rows).toEqual([{ count: 0 }]);
  expect((await replacement.raw("SELECT to_regclass('public.fixture_sequence') AS relation", [])).rows)
    .toEqual([{ relation: null }]);
  await fixtures.destroyTestPlatformDb(replacement);
}

describe('integration route database fixture', () => {
  it('closes its real fallback engine if gateway construction fails before a database owner exists', async () => {
    const create = engines.createTestPGlite;
    const instance = await create();
    vi.spyOn(engines, 'createTestPGlite').mockResolvedValueOnce(instance);
    vi.spyOn(gatewayDb, 'createPlatformDb').mockImplementationOnce(() => {
      throw new Error('Synthetic gateway construction failure');
    });
    try {
      await expect(manager().createTestPlatformDb(undefined)).rejects.toThrow('Synthetic gateway construction failure');
      expect(instance.client.closed).toBe(true);
    } finally { if (!instance.client.closed) await instance.client.close(); }
  });
  it('preserves gateway migration, defaults, constraints, data and sequence isolation with the URL unset', async () => {
    await verifyIsolation(undefined);
  });
  it('owns fallback databases destroyed directly by the unchanged route teardown', async () => {
    const fixtures = manager();
    const { db } = await fixtures.createTestPlatformDb(undefined);
    await db.destroy();
    await fixtures.drainClones();
    const { db: next } = await fixtures.createTestPlatformDb(undefined);
    expect((await next.raw('SELECT count(*)::int AS count FROM users', [])).rows).toEqual([{ count: 0 }]);
    await fixtures.destroyTestPlatformDb(next);
  });
  it.skipIf(!liveUrl)('preserves unchanged gateway bootstrap on independent native clones and reused name slots', async () => {
    await verifyIsolation(liveUrl);
  });
});
