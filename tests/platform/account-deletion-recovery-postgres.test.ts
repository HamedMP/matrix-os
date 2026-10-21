import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createPlatformDb, getActiveUserMachineByClerkId, insertUserMachine, updateUserMachine } from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!connectionString)('account deletion recovery lock on PostgreSQL', () => {
  it('restores the old machine after expiry when raw server IDs are PostgreSQL bigint strings',async()=>{
    const schema=`recovery_rollback_${randomUUID().replaceAll('-','')}`;
    const admin=new Kysely({dialect:new PostgresDialect({pool:new Pool({connectionString,max:1})})});
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const db=createPlatformDb({dialect:new PostgresDialect({pool:new Pool({connectionString,max:2,options:`-c search_path=${schema},public`})})});
    try{
      await db.ready;
      // Provider IDs may be widened in upgraded databases and arrive as int8 strings.
      await sql`ALTER TABLE user_machines ALTER COLUMN hetzner_server_id TYPE BIGINT`.execute(db.executor);
      await insertUserMachine(db,{machineId:'old-machine',clerkUserId:'user_rollback',handle:'rollback',status:'running',runtimeSlot:'primary',
        hetznerServerId:123,serverType:'cpx22',provisionedAt:'2026-10-04T12:00:00.000Z'});
      const hetzner=createMockHetznerClient();
      const service=createCustomerVpsService({db,hetzner,systemStore:createMockCustomerVpsSystemStore({hasDbLatest:vi.fn().mockResolvedValue(true)}),
        config:loadCustomerVpsConfig({PLATFORM_SECRET:'platform-secret',HETZNER_API_TOKEN:'test',S3_ACCESS_KEY_ID:'test',S3_SECRET_ACCESS_KEY:'test',S3_ENDPOINT:'https://r2.example',R2_BUCKET:'test'})});
      const replacement=await service.recover({clerkUserId:'user_rollback'});
      await updateUserMachine(db,replacement.machineId,{registrationTokenExpiresAt:'2020-01-01T00:00:00.000Z',provisionedAt:'2020-01-01T00:00:00.000Z'});
      const raw=await db.executor.selectFrom('user_machines').select('hetzner_server_id').where('machine_id','=',replacement.machineId).executeTakeFirstOrThrow();
      expect(raw.hetzner_server_id).toBe('123456');
      vi.mocked(hetzner.getServer).mockImplementation(async id=>id===123?{id:123,status:'running'}:null);
      await service.reconcileProvisioning();
      const restored=await getActiveUserMachineByClerkId(db,'user_rollback','primary');
      expect(restored?.machineId).toBe('old-machine');
      expect(restored?.status).toBe('running');
      expect(restored?.hetznerServerId).toBe(123);
      expect(restored?.recoveryEncryptedPayload).toBeNull();
      expect(hetzner.deleteServer).toHaveBeenCalledWith(123456);
    }finally{await db.destroy();await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin);await admin.destroy();}
  });
  it('normalizes raw bigint action and server IDs before provider cleanup and deduplicates inventory', async () => {
    const schema = `deletion_ids_${randomUUID().replaceAll('-', '')}`;
    const admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const db = createPlatformDb({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 2, options: `-c search_path=${schema},public` }) }) });
    try {
      await db.ready;
      await insertUserMachine(db, { machineId: 'ids-machine', clerkUserId: 'user_ids', handle: 'idstest', status: 'deleted', deletedAt: '2026-10-04T12:00:00.000Z', provisionedAt: '2026-10-04T12:00:00.000Z', recoveryOldServerId: 123, recoveryCreateActionId: 456 });
      let removed = false;
      const getAction = vi.fn(async (id: number) => { expect(typeof id).toBe('number'); return { id, status: 'success' as const, command: 'create_server' }; });
      const getServer = vi.fn(async (id: number) => { expect(typeof id).toBe('number'); return removed ? null : { id, status: 'running' }; });
      const deleteServer = vi.fn(async (_id: number) => { removed = true; });
      await createAccountDeletionAdapters({ db, clerkSecretKey: 'test', r2PrefixRoot: 'sync', customerVpsService: { delete: vi.fn() },
        fetch: vi.fn(async () => Response.json({ data: [], total_count: 0 })),
        hetzner: { getAction, getServer, deleteServer, listServersByLabel: async () => [{ id: 123, status: 'running', labels: { clerk_user_id: 'user_ids' } }] },
      }).vps({ clerkUserId: 'user_ids', appleTokens: [] });
      expect(getAction).toHaveBeenCalledWith(456); expect(deleteServer).toHaveBeenCalledExactlyOnceWith(123);
      expect(getServer).toHaveBeenCalledTimes(2);
    } finally { await db.destroy(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); }
  });
  it('waits for a delayed provider recovery outcome before accepting deletion and retains the ambiguous intent', async () => {
    const schema = `deletion_recovery_${randomUUID().replaceAll('-', '')}`;
    const owner = 'user_recovery_race'; const secret = 'deletion-recovery-postgres-secret-32';
    const admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const db = createPlatformDb({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 4, application_name: schema, options: `-c search_path=${schema},public` }) }) });
    vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    try {
      await db.ready;
      await insertUserMachine(db, { machineId: 'old-race', clerkUserId: owner, handle: 'recoveryrace', status: 'running', runtimeSlot: 'primary', hetznerServerId: 123, serverType: 'cpx22', provisionedAt: '2026-10-04T12:00:00.000Z' });
      expect(await getActiveUserMachineByClerkId(db, owner, 'primary')).toMatchObject({ hetznerServerId: 123 });
      const hetzner = createMockHetznerClient({ createServer: vi.fn(async () => { started(); await gate; throw new DOMException('Provider timeout', 'TimeoutError'); }) });
      const service = createCustomerVpsService({ db, hetzner, systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn().mockResolvedValue(true) }),
        config: loadCustomerVpsConfig({ PLATFORM_SECRET: 'platform-secret', HETZNER_API_TOKEN: 'test', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test', S3_ENDPOINT: 'https://r2.example', R2_BUCKET: 'test' }) });
      const recovery = service.recover({ clerkUserId: owner }).then(() => false, () => true);
      await providerStarted;
      const repo = new AccountDeletionRepository(db.kysely, { secret });
      const scheduling = repo.accept({ clerkUserId: owner, appleTokens: [] }, false);
      try {
        let observedWaiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const locks = await sql<{ waiting: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid = lock.pid
            WHERE lock.locktype = 'advisory' AND NOT lock.granted AND activity.application_name = ${schema}
          ) AS waiting`.execute(admin);
          if (locks.rows[0]!.waiting) { observedWaiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(observedWaiting).toBe(true);
      } finally { release(); }
      expect(await recovery).toBe(true); await scheduling;
      const pending = await getActiveUserMachineByClerkId(db, owner, 'primary');
      expect(pending).toMatchObject({ status: 'recovering', hetznerServerId: null });
      expect(pending?.recoveryOldServerId).toBe(123);
      expect(pending?.recoveryEncryptedPayload).toEqual(expect.any(String));
      await service.reconcileProvisioning();
      expect(hetzner.createServer).toHaveBeenCalledOnce();
      expect(hetzner.listServersByLabel).not.toHaveBeenCalled();
    } finally {
      release(); vi.unstubAllEnvs(); await db.destroy();
      await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy();
    }
  }, 20_000);
});
